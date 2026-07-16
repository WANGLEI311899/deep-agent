/**
 * DeepAgent Web UI 服务
 * - 多会话历史
 * - SSE 流式对话 + 工具调用事件
 * - HITL 弹窗确认（写文件 / 高风险）
 *
 * 运行：npm run ui
 */
import 'dotenv/config'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { createAgent, type DeepAgent } from './agent.js'
import {
  SessionStore,
  type Session,
  type ToolCallEvent,
  type UiMessage,
} from './sessions.js'
import { WorkspaceStore } from './workspace-store.js'
import type { HitlRequestMeta } from './hitl.js'

const PORT = Number(process.env.PORT ?? 5173)
const PUBLIC_DIR = path.resolve(process.cwd(), 'web/public')

const store = new SessionStore()
const workspaces = new WorkspaceStore()
let agent: DeepAgent | null = null
/** sessionId -> busy */
const busySessions = new Set<string>()

interface PendingHitl {
  id: string
  sessionId: string
  operation: string
  meta?: HitlRequestMeta
  resolve: (approved: boolean) => void
  createdAt: number
  timer: ReturnType<typeof setTimeout>
}

const pendingHitl = new Map<string, PendingHitl>()
const HITL_TIMEOUT_MS = 5 * 60 * 1000

const SYSTEM_PROMPT = `
你是 DeepAgent，一个专业的前端 + AI 全栈智能体，由 DeepSeek 驱动。
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

async function ensureAgent(): Promise<DeepAgent> {
  if (agent) return agent
  const active = workspaces.getActive()
  agent = await createAgent({
    name: 'DeepAgent',
    skillDir: '.deepagent/skills',
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
    sendJson(res, 403, { error: 'Forbidden' })
    return
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendJson(res, 404, { error: 'Not Found' })
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
  sessionId: string,
  operation: string,
  meta: HitlRequestMeta | undefined,
  emit: (payload: unknown) => void,
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
    const timer = setTimeout(() => {
      const pending = pendingHitl.get(id)
      if (!pending) return
      pendingHitl.delete(id)
      console.log(`[HITL] 请求 ${id} 超时，默认拒绝`)
      resolve(false)
    }, HITL_TIMEOUT_MS)

    pendingHitl.set(id, {
      id,
      sessionId,
      operation,
      meta,
      resolve: (approved) => {
        clearTimeout(timer)
        pendingHitl.delete(id)
        resolve(approved)
      },
      createdAt: Date.now(),
      timer,
    })
  })
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: { message?: string; sessionId?: string } = {}
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { error: '请求体必须是 JSON。' })
    return
  }

  const message = (body.message ?? '').trim()
  if (!message) {
    sendJson(res, 400, { error: 'message 不能为空。' })
    return
  }

  let session = body.sessionId ? store.get(body.sessionId) : undefined
  if (!session) {
    session = store.ensureActive()
  } else {
    store.setActive(session.id)
  }

  // 单 Agent 实例：全局同时只允许一轮对话（含跨会话）
  if (busySessions.size > 0) {
    sendJson(res, 429, { error: 'Agent 正在处理消息，请稍候。' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  busySessions.add(session.id)
  let closed = false
  req.on('close', () => {
    closed = true
  })

  const emit = (event: string, data: unknown) => {
    if (!closed) writeSse(res, event, data)
  }

  try {
    const current = await ensureAgent()
    // 每轮对话前同步当前激活的本地输出目录
    current.setOutputPath(workspaces.getActivePath(), false)
    bindSessionHistory(session)

    // 本轮对话的 HITL 绑定到当前 SSE
    current.setHitlConfig({
      enabled: true,
      autoApprove: false,
      confirmFileWrites: true,
      confirmHandler: (operation, meta) =>
        createHitlWaiter(session!.id, operation, meta, (payload) =>
          emit('hitl', payload),
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
      sessionId: session.id,
      messageId: assistantId,
      content: full,
      filesWritten: result.filesWritten,
      tools: result.tools,
      cancelled: !!result.cancelled,
      title: session.title,
    })
    res.end()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[Server] chat error:', error)
    emit('error', { error: msg })
    if (!res.writableEnded) res.end()
  } finally {
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
): Promise<void> {
  let body: { id?: string; approved?: boolean } = {}
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { error: '无效 JSON' })
    return
  }

  const id = body.id
  if (!id || typeof body.approved !== 'boolean') {
    sendJson(res, 400, { error: '需要 id 与 approved 字段' })
    return
  }

  const pending = pendingHitl.get(id)
  if (!pending) {
    sendJson(res, 404, { error: '确认请求不存在或已过期' })
    return
  }

  pending.resolve(body.approved)
  sendJson(res, 200, { ok: true, id, approved: body.approved })
}

async function handleMeta(res: http.ServerResponse): Promise<void> {
  const current = await ensureAgent()
  const skills = current.getSkills().map((s) => ({
    name: s.name,
    fileName: s.fileName,
    description: s.description,
  }))
  const activeWs = workspaces.getActive()
  sendJson(res, 200, {
    name: 'DeepAgent',
    model: current.getModel(),
    skills,
    activeSessionId: store.getActiveId(),
    workspace: workspaces.snapshot(),
    outputPath: current.getOutputPath(),
    activeWorkspace: activeWs,
  })
}

async function handleFiles(res: http.ServerResponse): Promise<void> {
  const current = await ensureAgent()
  const sandbox = current.getSandbox()
  const active = workspaces.getActive()
  sendJson(res, 200, {
    files: sandbox?.listFiles() ?? [],
    outputPath: sandbox?.outputPath ?? active.path,
    workspace: active,
  })
}

async function handleWorkspaces(
  method: string,
  url: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (method === 'GET' && url === '/api/workspaces') {
    sendJson(res, 200, workspaces.snapshot())
    return true
  }

  if (method === 'POST' && url === '/api/workspaces') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      name?: string
      path?: string
    }
    if (!body.path?.trim()) {
      sendJson(res, 400, {
        error: 'path 不能为空，请填写本机任意绝对路径，例如 D:\\\\docs\\\\my-folder',
      })
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
      workspaces.remove(id)
      await applyActiveWorkspace()
      sendJson(res, 200, { ok: true, workspace: workspaces.snapshot() })
      return true
    }
  }

  const activate = url.match(/^\/api\/workspaces\/([^/]+)\/activate$/)
  if (method === 'POST' && activate) {
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
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = (req.url ?? '/').split('?')[0]
  const method = req.method ?? 'GET'

  try {
    if (method === 'GET' && url === '/api/meta') {
      await handleMeta(res)
      return
    }
    if (method === 'GET' && url === '/api/files') {
      await handleFiles(res)
      return
    }
    if (await handleWorkspaces(method, url, req, res)) {
      return
    }
    if (method === 'GET' && url === '/api/sessions') {
      sendJson(res, 200, {
        sessions: store.list(),
        activeSessionId: store.getActiveId(),
      })
      return
    }
    if (method === 'POST' && url === '/api/sessions') {
      const session = store.create()
      sendJson(res, 201, sessionPublic(session))
      return
    }

    const getOne = matchRoute(url, /^\/api\/sessions\/([^/]+)$/)
    if (method === 'GET' && getOne) {
      const session = store.get(decodeURIComponent(getOne[1]))
      if (!session) {
        sendJson(res, 404, { error: '会话不存在' })
        return
      }
      store.setActive(session.id)
      sendJson(res, 200, sessionPublic(session))
      return
    }
    if (method === 'DELETE' && getOne) {
      const id = decodeURIComponent(getOne[1])
      const ok = store.delete(id)
      if (!ok) {
        sendJson(res, 404, { error: '会话不存在' })
        return
      }
      // 若删光了，自动建一个空会话
      if (!store.getActiveId()) store.create()
      sendJson(res, 200, {
        ok: true,
        activeSessionId: store.getActiveId(),
        sessions: store.list(),
      })
      return
    }

    const clearOne = matchRoute(url, /^\/api\/sessions\/([^/]+)\/clear$/)
    if (method === 'POST' && clearOne) {
      const session = store.get(decodeURIComponent(clearOne[1]))
      if (!session) {
        sendJson(res, 404, { error: '会话不存在' })
        return
      }
      store.clearSession(session)
      if (store.getActiveId() === session.id) {
        const current = await ensureAgent()
        current.clearHistory()
      }
      sendJson(res, 200, { ok: true, session: sessionPublic(session) })
      return
    }

    if (method === 'POST' && url === '/api/chat') {
      await handleChat(req, res)
      return
    }
    if (method === 'POST' && url === '/api/hitl') {
      await handleHitl(req, res)
      return
    }
    // 兼容旧 clear：清空当前会话
    if (method === 'POST' && url === '/api/clear') {
      const session = store.ensureActive()
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

    sendJson(res, 404, { error: 'Not Found' })
  } catch (error) {
    console.error('[Server] request error:', error)
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
})

async function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    throw new Error(`静态资源目录不存在：${PUBLIC_DIR}`)
  }

  console.log('🚀 正在初始化 DeepAgent...')
  await ensureAgent()
  // 无持久化会话时再创建空会话
  store.ensureActive()

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
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    flushSessions()
    process.exit(0)
  })

  const active = workspaces.getActive()
  server.listen(PORT, () => {
    console.log('')
    console.log('═'.repeat(50))
    console.log(`  DeepAgent UI 已启动`)
    console.log(`  打开浏览器：http://localhost:${PORT}`)
    console.log(`  当前输出目录：${active.path}`)
    console.log(`  会话数：${store.list().length}（已持久化）`)
    console.log('═'.repeat(50))
    console.log('')
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
