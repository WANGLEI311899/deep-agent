/**
 * 简易访问口令鉴权 + 聊天限流（面向公网部署）。
 */
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import { deployConfig, isAuthEnabled } from './deploy-config.js'

function sendJson(
  res: ServerResponse,
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

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  try {
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/** 从 Header 或 Query 读取口令 */
export function extractAccessToken(req: IncomingMessage): string {
  const auth = req.headers.authorization
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  const headerToken = req.headers['x-access-token']
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim()
  }
  try {
    const host = req.headers.host ?? 'localhost'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const q = url.searchParams.get('token')
    if (q) return q.trim()
  } catch {
    /* ignore */
  }
  return ''
}

export function isAuthorized(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true
  const provided = extractAccessToken(req)
  if (!provided) return false
  return safeEqual(provided, deployConfig.accessToken)
}

/**
 * 校验 /api/* 请求。
 * @returns true 表示已拦截并写了响应
 */
export function rejectUnauthorized(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (isAuthorized(req)) return false
  sendJson(res, 401, {
    error: '需要访问口令。请在界面输入 ACCESS_TOKEN，或请求头携带 Authorization: Bearer <token>。',
    code: 'UNAUTHORIZED',
  })
  return true
}

/** 简易滑动窗口限流：key -> 时间戳列表 */
const chatHits = new Map<string, number[]>()

export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim()
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * 聊天接口限流。
 * @returns true 表示已拦截
 */
export function rejectRateLimited(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const limit = deployConfig.rateLimitPerMin
  const ip = clientIp(req)
  const now = Date.now()
  const windowMs = 60_000
  const prev = chatHits.get(ip) ?? []
  const recent = prev.filter((t) => now - t < windowMs)
  if (recent.length >= limit) {
    sendJson(res, 429, {
      error: `请求过于频繁，每分钟最多 ${limit} 次对话，请稍后再试。`,
      code: 'RATE_LIMITED',
    })
    chatHits.set(ip, recent)
    return true
  }
  recent.push(now)
  chatHits.set(ip, recent)
  // 偶尔清理，避免 Map 无限增长
  if (chatHits.size > 5000) {
    for (const [k, times] of chatHits) {
      const keep = times.filter((t) => now - t < windowMs)
      if (keep.length) chatHits.set(k, keep)
      else chatHits.delete(k)
    }
  }
  return false
}
