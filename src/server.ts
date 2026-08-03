/**
 * deepCodex Web UI 服务
 * - 多会话历史
 * - SSE 流式对话 + 工具调用事件
 * - HITL 弹窗确认（写文件 / 高风险）
 * - 可选访问口令 / 公网模式 / 限流
 *
 * 运行：npm run ui
 * 生产：npm start（需先 build，并设置 ACCESS_TOKEN + PUBLIC_MODE）
 */
import 'dotenv/config'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { createAgent, type deepCodex } from './agent.js'
import {
  SessionStore,
  type Session,
  type ToolCallEvent,
  type UiMessage,
} from './sessions.js'
import { WorkspaceStore } from './workspace-store.js'
import type { HitlRequestMeta } from './hitl.js'
import {
  assertDeployConfig,
  deployConfig,
  isAuthEnabled,
} from './deploy-config.js'
import {
  getAuthPrincipal,
  isAuthorized,
  rejectRateLimited,
  rejectUnauthorized,
} from './auth.js'
import { AppError, ErrorCodes, errorResponse, normalizeError } from './errors.js'
import { logger, requestLogger } from './logger.js'
import { captureException, flushTelemetry, initTelemetry } from './telemetry.js'

const PORT = deployConfig.port
const HOST = deployConfig.host
const PUBLIC_DIR = path.resolve(process.cwd(), 'web/public')

const store = new SessionStore()
const workspaces = new WorkspaceStore()
let agent: deepCodex | null = null
/** sessionId -> busy */
const busySessions = new Set<string>()

interface PendingHitl {
  id: string
  sessionId: string
  userId: string
  operation: string
  meta?: HitlRequestMeta
  resolve: (approved: boolean) => void
  createdAt: number
  timer: ReturnType<typeof setTimeout>
}

const pendingHitl = new Map<string, PendingHitl>()
const HITL_TIMEOUT_MS = 5 * 60 * 1000

const SYSTEM_PROMPT = `
你是 deepCodex，一个专业的前端 + AI 全栈智能体，由 DeepSeek 驱动。
你擅长：
- TypeScript / Vue3 / React 前端开发
- LangChain / Deep Agent AI 应用开发
- 代码审查和架构设计建议
- 技术文档生成

回复要求：
- 使用中文回复
- 需要写文件时使用规定的 filename 格式
- 每次先简单说明你打算怎么做，再给出结果
`

async function ensureAgent(): Promise<deepCodex> {
  if (agent) return agent
  const active = workspaces.getActive()
  agent = await createAgent({
    name: 'deepCodex',
    skillDir: '.deepcodex/skills',
    sandbox: {
      workspacePath: process.cwd(),
      outputPath: active.path,
      verbose: true,
    },
    hitl: {
      enabled: true,
      autoApprove: false,
      confirmFileWrites: true,
    },
    systemPrompt: SYSTEM_PROMPT,
    maxHistoryMessages: Number(process.env.DEEPSEEK_MAX_HISTORY ?? 20),
  })
  return agent
}

/** 将 Agent 沙箱切换到当前激活的本地目录 */
async function applyActiveWorkspace(): Promise<void> {
  const current = await ensureAgent()
  const active = workspaces.getActive()
  current.setOutputPath(active.path, true)
}

function bindSessionHistory(session: Session): void {
  if (!agent) return
  agent.setHistory(session.agentHistory)
}

function persistAgentHistory(session: Session): void {
  if (!agent) return
  session.agentHistory = agent.getHistory()
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 所有失败响应使用同一结构，前端可按 code 和 retryable 做稳定处理。 */
function sendError(
  res: http.ServerResponse,
  requestId: string,
  error: AppError,
): void {
  sendJson(res, error.statusCode, errorResponse(error, requestId))
}

function sendStandardError(res: http.ServerResponse, error: AppError): void {
  sendError(res, String(res.getHeader('X-Request-Id') || 'unknown'), error)
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  }
  return map[ext] ?? 'application/octet-stream'
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = (req.url ?? '/').split('?')[0]
  const safePath = urlPath === '/' ? '/index.html' : urlPath
  const resolved = path.normalize(path.join(PUBLIC_DIR, safePath))

  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendStandardError(res, new AppError(ErrorCodes.InvalidRequest, 'Forbidden', 403, 'static_files'))
    return
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendStandardError(res, new AppError(ErrorCodes.NotFound, 'Not Found', 404, 'static_files'))
    return
  }

  const data = fs.readFileSync(resolved)
  res.writeHead(200, { 'Content-Type': contentType(resolved) })
  res.end(data)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function writeSse(res: http.ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function sessionPublic(session: Session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.uiMessages,
    filesWritten: session.filesWritten,
  }
}

function createHitlWaiter(
  userId: string,
  sessionId: string,
  operation: string,
  meta: HitlRequestMeta | undefined,
  emit: (payload: unknown) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const id = randomUUID()
  emit({
    id,
    sessionId,
    operation,
    riskLevel: meta?.riskLevel ?? 'medium',
    type: meta?.type ?? 'custom',
    detail: meta?.detail ?? null,
  })

  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      const pending = pendingHitl.get(id)
      if (pending) pending.resolve(false)
      else resolve(false)
    }
    const timer = setTimeout(() => {
      const pending = pendingHitl.get(id)
      if (!pending) return
      pendingHitl.delete(id)
      signal.removeEventListener('abort', onAbort)
      console.log(`[HITL] 请求 ${id} 超时，默认拒绝`)
      resolve(false)
    }, HITL_TIMEOUT_MS)

    pendingHitl.set(id, {
      id,
      userId,
      sessionId,
      operation,
      meta,
      resolve: (approved) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        pendingHitl.delete(id)
        resolve(approved)
      },
      createdAt: Date.now(),
      timer,
    })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  requestId: string,
): Promise<void> {
  const log = requestLogger(requestId, { userId, route: '/api/chat' })
  const startedAt = Date.now()
  let body: { message?: string; sessionId?: string } = {}
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendError(res, requestId, new AppError(ErrorCodes.InvalidRequest, '请求体必须是 JSON。', 400, 'request_parse'))
    return
  }

  const message = (body.message ?? '').trim()
  if (!message) {
    sendError(res, requestId, new AppError(ErrorCodes.InvalidRequest, 'message 不能为空。', 400, 'request_validation'))
    return
  }

  let session = body.sessionId ? store.get(body.sessionId, userId) : undefined
  if (!session) {
    session = store.ensureActive(userId)
  } else {
    store.setActive(session.id, userId)
  }

  // 单 Agent 实例：全局同时只允许一轮对话（含跨会话）
  if (busySessions.size > 0) {
    log.warn({ event: 'agent.busy', activeRequests: busySessions.size }, 'Agent 正忙')
    sendError(res, requestId, new AppError(ErrorCodes.AgentBusy, 'Agent 正在处理消息，请稍候。', 429, 'agent_queue', true))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Request-Id': requestId,
  })
  res.write(': connected\n\n')

  busySessions.add(session.id)
  log.info({ event: 'chat.started', sessionId: session.id, promptChars: message.length }, '对话开始')
  let closed = false
  const requestController = new AbortController()
  const requestTimeoutMs = Number(
    process.env.AGENT_REQUEST_TIMEOUT_MS ?? 120_000,
  )
  const requestTimer = setTimeout(() => {
    requestController.abort(
      new Error(`Agent 请求超过 ${requestTimeoutMs}ms，已自动取消。`),
    )
    log.warn({ event: 'chat.timeout', sessionId: session.id, timeoutMs: requestTimeoutMs }, '对话超时')
  }, requestTimeoutMs)
  // SSE 响应断开才代表浏览器离开；不能使用请求体的 close 事件判断。
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true
      log.info({ event: 'client.disconnected', sessionId: session.id }, '客户端断开连接')
      requestController.abort(new Error('客户端已断开连接。'))
    }
  })

  const emit = (event: string, data: unknown) => {
    if (!closed) writeSse(res, event, data)
  }

  try {
    const current = await ensureAgent()
    // 每轮对话前同步当前激活的本地输出目录
    // 多用户口令使用独立输出目录；owner/local 继续兼容自定义工作区。
    const userOutputPath =
      userId === 'owner' || userId === 'local'
        ? workspaces.getActivePath()
        : path.resolve(process.cwd(), 'output', 'users', userId)
    current.setOutputPath(userOutputPath, false)
    bindSessionHistory(session)

    // 本轮对话的 HITL 绑定到当前 SSE
    current.setHitlConfig({
      enabled: true,
      autoApprove: false,
      confirmFileWrites: true,
      confirmHandler: (operation, meta) =>
        createHitlWaiter(
          userId,
          session!.id,
          operation,
          meta,
          (payload) => emit('hitl', payload),
          requestController.signal,
        ),
    })

    const userMsg: UiMessage = {
      id: randomUUID(),
      role: 'user',
      content: message,
      createdAt: Date.now(),
    }
    store.addUiMessage(session, userMsg)
    store.touch(session, message)

    const assistantId = randomUUID()
    const assistantMsg: UiMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      tools: [],
      filesWritten: [],
      createdAt: Date.now(),
    }
    store.addUiMessage(session, assistantMsg)

    emit('session', {
      id: session.id,
      title: session.title,
    })
    emit('status', { status: 'thinking' })

    let full = ''
    // 流式过程中节流写盘：避免每个 token 都触发 sessions.json 重写
    let lastPersistAt = 0
    const PERSIST_EVERY_MS = 500
    const result = await current.invokeStream(message, {
      writeToStdout: false,
      signal: requestController.signal,
      userId,
      sessionId: session.id,
      onStatus: (status) => emit('status', { status }),
      onChunk: (delta) => {
        full += delta
        const nowTs = Date.now()
        if (nowTs - lastPersistAt >= PERSIST_EVERY_MS) {
          store.updateUiMessage(session!, assistantId, { content: full })
          lastPersistAt = nowTs
        }
        emit('chunk', { text: delta, messageId: assistantId })
      },
      onTool: (tool: ToolCallEvent) => {
        log.info({
          event: `tool.${tool.status}`,
          sessionId: session!.id,
          toolCallId: tool.id,
          toolName: tool.name,
          toolStatus: tool.status,
          durationMs: tool.endedAt ? tool.endedAt - tool.startedAt : undefined,
        }, '工具状态变化')
        store.upsertTool(session!, assistantId, tool)
        emit('tool', { messageId: assistantId, tool })
      },
    })

    full = result.content || full
    if (result.filesWritten.length) {
      session.filesWritten = [
        ...new Set([...session.filesWritten, ...result.filesWritten]),
      ]
    }

    store.updateUiMessage(session, assistantId, {
      content: full,
      tools: result.tools,
      filesWritten: result.filesWritten,
    })
    persistAgentHistory(session)
    store.flush()

    emit('done', {
      requestId,
      sessionId: session.id,
      messageId: assistantId,
      content: full,
      filesWritten: result.filesWritten,
      tools: result.tools,
      cancelled: !!result.cancelled,
      title: session.title,
    })
    log.info({
      event: 'chat.succeeded',
      sessionId: session.id,
      durationMs: Date.now() - startedAt,
      outputChars: full.length,
      filesWritten: result.filesWritten.length,
    }, '对话完成')
    res.end()
  } catch (error) {
    const cancelled = requestController.signal.aborted
    const reason = requestController.signal.reason
    const timedOut = reason instanceof Error && reason.message.includes('超过')
    const normalized = cancelled
      ? new AppError(
          timedOut ? ErrorCodes.LlmTimeout : ErrorCodes.ClientDisconnected,
          timedOut ? 'Agent 请求超时，请稍后重试。' : '客户端已断开连接。',
          timedOut ? 504 : 499,
          timedOut ? 'agent_request' : 'sse_stream',
          true,
          { cause: error },
        )
      : normalizeError(error, 'llm_generate')
    log.error({
      event: cancelled ? 'chat.cancelled' : 'chat.failed',
      err: error,
      code: normalized.code,
      stage: normalized.stage,
      sessionId: session.id,
      durationMs: Date.now() - startedAt,
    }, normalized.message)
    captureException(error, {
      requestId,
      sessionId: session.id,
      userId,
      code: normalized.code,
      stage: normalized.stage,
    })
    emit(cancelled ? 'cancelled' : 'error', errorResponse(normalized, requestId))
    if (!res.writableEnded) res.end()
  } finally {
    clearTimeout(requestTimer)
    busySessions.delete(session.id)
    // 清理可能残留的 HITL（连接断开时拒绝）
    for (const [id, p] of pendingHitl) {
      if (p.sessionId === session.id && closed) {
        p.resolve(false)
        clearTimeout(p.timer)
        pendingHitl.delete(id)
      }
    }
  }
}

async function handleHitl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
): Promise<void> {
  let body: { id?: string; approved?: boolean } = {}
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendStandardError(res, new AppError(ErrorCodes.InvalidRequest, '无效 JSON', 400, 'hitl_parse'))
    return
  }

  const id = body.id
  if (!id || typeof body.approved !== 'boolean') {
    sendStandardError(res, new AppError(ErrorCodes.InvalidRequest, '需要 id 与 approved 字段', 400, 'hitl_validation'))
    return
  }

  const pending = pendingHitl.get(id)
  if (!pending || pending.userId !== userId) {
    sendStandardError(res, new AppError(ErrorCodes.NotFound, '确认请求不存在或已过期', 404, 'hitl_lookup'))
    return
  }

  pending.resolve(body.approved)
  sendJson(res, 200, { ok: true, id, approved: body.approved })
}

async function handleMeta(
  res: http.ServerResponse,
  userId: string,
): Promise<void> {
  const current = await ensureAgent()
  const skills = current.getSkills().map((s) => ({
    name: s.name,
    fileName: s.fileName,
    description: s.description,
  }))
  const activeWs = workspaces.getActive()
  const ownsGlobalWorkspace = userId === 'owner' || userId === 'local'
  sendJson(res, 200, {
    name: 'deepCodex',
    model: current.getModel(),
    skills,
    activeSessionId: store.getActiveId(userId),
    workspace: ownsGlobalWorkspace ? workspaces.snapshot() : null,
    outputPath: current.getOutputPath(),
    activeWorkspace: ownsGlobalWorkspace ? activeWs : null,
    authRequired: isAuthEnabled(),
    publicMode: deployConfig.publicMode,
    /** 公网模式下禁止自定义任意本机路径 */
    workspacesLocked: deployConfig.publicMode || !ownsGlobalWorkspace,
  })
}

async function handleFiles(
  res: http.ServerResponse,
  userId: string,
): Promise<void> {
  const current = await ensureAgent()
  if (userId !== 'owner' && userId !== 'local') {
    current.setOutputPath(
      path.resolve(process.cwd(), 'output', 'users', userId),
      false,
    )
  }
  const sandbox = current.getSandbox()
  const active = workspaces.getActive()
  sendJson(res, 200, {
    files: sandbox?.listFiles() ?? [],
    outputPath: sandbox?.outputPath ?? active.path,
    workspace:
      userId === 'owner' || userId === 'local'
        ? active
        : { id: `user-${userId}`, name: '个人输出目录', path: sandbox?.outputPath },
  })
}

function rejectPublicWorkspaceMutation(res: http.ServerResponse): boolean {
  if (!deployConfig.publicMode) return false
  sendStandardError(res, new AppError(ErrorCodes.WorkspaceLocked, '公网模式下已锁定输出目录（仅允许服务器默认 output），禁止配置任意本机路径。', 403, 'workspace_mutation'))
  return true
}

async function handleWorkspaces(
  method: string,
  url: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (method === 'GET' && url === '/api/workspaces') {
    sendJson(res, 200, {
      ...workspaces.snapshot(),
      locked: deployConfig.publicMode,
    })
    return true
  }

  if (method === 'POST' && url === '/api/workspaces') {
    if (rejectPublicWorkspaceMutation(res)) return true
    const body = JSON.parse((await readBody(req)) || '{}') as {
      name?: string
      path?: string
    }
    if (!body.path?.trim()) {
      sendStandardError(res, new AppError(ErrorCodes.InvalidRequest, 'path 不能为空，请填写本机任意绝对路径，例如 D:\\\\docs\\\\my-folder', 400, 'workspace_validation'))
      return true
    }
    const folder = workspaces.add(body.name || '', body.path)
    await applyActiveWorkspace()
    sendJson(res, 201, { folder, workspace: workspaces.snapshot() })
    return true
  }

  const one = url.match(/^\/api\/workspaces\/([^/]+)$/)
  if (one) {
    const id = decodeURIComponent(one[1])
    if (method === 'PUT' || method === 'PATCH') {
      if (rejectPublicWorkspaceMutation(res)) return true
      const body = JSON.parse((await readBody(req)) || '{}') as {
        name?: string
        path?: string
      }
      const folder = workspaces.update(id, body)
      // 若改的是当前激活目录，或路径变更后需要同步沙箱
      if (workspaces.getActive().id === id) {
        await applyActiveWorkspace()
      }
      sendJson(res, 200, { folder, workspace: workspaces.snapshot() })
      return true
    }
    if (method === 'DELETE') {
      if (rejectPublicWorkspaceMutation(res)) return true
      workspaces.remove(id)
      await applyActiveWorkspace()
      sendJson(res, 200, { ok: true, workspace: workspaces.snapshot() })
      return true
    }
  }

  const activate = url.match(/^\/api\/workspaces\/([^/]+)\/activate$/)
  if (method === 'POST' && activate) {
    if (rejectPublicWorkspaceMutation(res)) return true
    const id = decodeURIComponent(activate[1])
    const folder = workspaces.setActive(id)
    await applyActiveWorkspace()
    sendJson(res, 200, { folder, workspace: workspaces.snapshot() })
    return true
  }

  return false
}

function matchRoute(
  url: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  return url.match(pattern)
}

const server = http.createServer(async (req, res) => {
  const suppliedRequestId = req.headers['x-request-id']
  const requestId =
    typeof suppliedRequestId === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID()
  const requestStartedAt = Date.now()
  const log = requestLogger(requestId)
  res.setHeader('X-Request-Id', requestId)
  res.once('finish', () => {
    log.info({
      event: 'http.request.completed',
      method: req.method,
      path: (req.url ?? '/').split('?')[0],
      statusCode: res.statusCode,
      durationMs: Date.now() - requestStartedAt,
    }, 'HTTP 请求完成')
  })
  log.info({ event: 'http.request.started', method: req.method, path: (req.url ?? '/').split('?')[0] }, 'HTTP 请求开始')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Access-Token, X-Request-Id',
  )

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = (req.url ?? '/').split('?')[0]
  const method = req.method ?? 'GET'

  try {
    // 健康检查：平台探活用，不要求口令
    if (method === 'GET' && url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        publicMode: deployConfig.publicMode,
        authRequired: isAuthEnabled(),
      })
      return
    }

    // 鉴权探测：前端判断是否需要登录；不要求已登录
    if (method === 'GET' && url === '/api/auth/status') {
      sendJson(res, 200, {
        authRequired: isAuthEnabled(),
        publicMode: deployConfig.publicMode,
        authorized: isAuthorized(req),
      })
      return
    }

    // 所有其它 /api/* 需要口令（若已配置 ACCESS_TOKEN）
    if (url.startsWith('/api/')) {
      if (rejectUnauthorized(req, res)) return
    }
    const userId = getAuthPrincipal(req)?.userId ?? 'local'

    if (method === 'GET' && url === '/api/meta') {
      await handleMeta(res, userId)
      return
    }
    if (method === 'GET' && url === '/api/files') {
      await handleFiles(res, userId)
      return
    }
    if (
      url.startsWith('/api/workspaces') &&
      userId !== 'owner' &&
      userId !== 'local'
    ) {
      sendStandardError(res, new AppError(ErrorCodes.WorkspaceLocked, '多用户账号使用独立固定输出目录，不能修改全局工作区。', 403, 'workspace_authorization'))
      return
    }
    if (await handleWorkspaces(method, url, req, res)) {
      return
    }
    if (method === 'GET' && url === '/api/sessions') {
      sendJson(res, 200, {
        sessions: store.list(userId),
        activeSessionId: store.getActiveId(userId),
      })
      return
    }
    if (method === 'POST' && url === '/api/sessions') {
      const session = store.create(userId)
      sendJson(res, 201, sessionPublic(session))
      return
    }

    const getOne = matchRoute(url, /^\/api\/sessions\/([^/]+)$/)
    if (method === 'GET' && getOne) {
      const session = store.get(decodeURIComponent(getOne[1]), userId)
      if (!session) {
        sendStandardError(res, new AppError(ErrorCodes.SessionNotFound, '会话不存在', 404, 'session_lookup'))
        return
      }
      store.setActive(session.id, userId)
      sendJson(res, 200, sessionPublic(session))
      return
    }
    if (method === 'DELETE' && getOne) {
      const id = decodeURIComponent(getOne[1])
      const ok = store.delete(id, userId)
      if (!ok) {
        sendStandardError(res, new AppError(ErrorCodes.SessionNotFound, '会话不存在', 404, 'session_delete'))
        return
      }
      // 若删光了，自动建一个空会话
      if (!store.getActiveId(userId)) store.create(userId)
      sendJson(res, 200, {
        ok: true,
        activeSessionId: store.getActiveId(userId),
        sessions: store.list(userId),
      })
      return
    }

    const clearOne = matchRoute(url, /^\/api\/sessions\/([^/]+)\/clear$/)
    if (method === 'POST' && clearOne) {
      const session = store.get(decodeURIComponent(clearOne[1]), userId)
      if (!session) {
        sendStandardError(res, new AppError(ErrorCodes.SessionNotFound, '会话不存在', 404, 'session_clear'))
        return
      }
      store.clearSession(session)
      if (store.getActiveId(userId) === session.id) {
        const current = await ensureAgent()
        current.clearHistory()
      }
      sendJson(res, 200, { ok: true, session: sessionPublic(session) })
      return
    }

    if (method === 'POST' && url === '/api/chat') {
      if (rejectRateLimited(req, res)) return
      await handleChat(req, res, userId, requestId)
      return
    }
    if (method === 'POST' && url === '/api/hitl') {
      await handleHitl(req, res, userId)
      return
    }
    // 兼容旧 clear：清空当前会话
    if (method === 'POST' && url === '/api/clear') {
      const session = store.ensureActive(userId)
      store.clearSession(session)
      const current = await ensureAgent()
      current.clearHistory()
      sendJson(res, 200, { ok: true, sessionId: session.id })
      return
    }

    if (method === 'GET') {
      serveStatic(req, res)
      return
    }

    sendStandardError(res, new AppError(ErrorCodes.NotFound, 'Not Found', 404, 'routing'))
  } catch (error) {
    const normalized = normalizeError(error, 'http_handler')
    log.error({ event: 'http.request.failed', err: error, code: normalized.code, stage: normalized.stage }, normalized.message)
    captureException(error, { requestId, code: normalized.code, stage: normalized.stage })
    if (!res.headersSent) {
      sendError(res, requestId, normalized)
    }
  }
})

async function main() {
  initTelemetry()
  assertDeployConfig()

  if (!fs.existsSync(PUBLIC_DIR)) {
    throw new Error(`静态资源目录不存在：${PUBLIC_DIR}`)
  }

  console.log('🚀 正在初始化 deepCodex...')
  await ensureAgent()
  // 无持久化会话时再创建空会话
  store.ensureActive('owner')

  const flushSessions = () => {
    try {
      store.flush()
    } catch {
      /* ignore */
    }
  }
  process.on('exit', flushSessions)
  process.on('SIGINT', () => {
    flushSessions()
    void flushTelemetry().finally(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    flushSessions()
    void flushTelemetry().finally(() => process.exit(0))
  })

  const active = workspaces.getActive()
  server.listen(PORT, HOST, () => {
    console.log('')
    console.log('═'.repeat(50))
    console.log(`  deepCodex UI 已启动`)
    console.log(`  本地访问：http://localhost:${PORT}`)
    console.log(`  监听地址：${HOST}:${PORT}`)
    console.log(`  公网模式：${deployConfig.publicMode ? '是（目录已锁定）' : '否'}`)
    console.log(`  访问口令：${isAuthEnabled() ? '已启用' : '未设置（仅适合本机）'}`)
    console.log(`  当前输出目录：${active.path}`)
    console.log(`  owner 会话数：${store.list('owner').length}（已持久化）`)
    console.log('═'.repeat(50))
    console.log('')
  })
}

main().catch((err) => {
  logger.fatal({ event: 'server.startup.failed', err }, '服务启动失败')
  captureException(err, { stage: 'startup', code: ErrorCodes.InternalError })
  void flushTelemetry().finally(() => process.exit(1))
})
