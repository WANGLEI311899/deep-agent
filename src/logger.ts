import pino from 'pino'

const level = process.env.LOG_LEVEL?.trim() || 'info'

/**
 * Pino 默认输出单行 JSON，方便 Docker、Railway 和 Render 直接采集。
 * redact 同时覆盖常见请求头和业务字段，防止密钥、正文或文件预览进入日志。
 */
export const logger = pino({
  level,
  base: {
    service: 'deep-codex',
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.x-access-token',
      'authorization',
      'accessToken',
      'apiKey',
      'token',
      'message',
      'prompt',
      'content',
      'preview',
      '*.preview',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

export function requestLogger(requestId: string, bindings: Record<string, unknown> = {}) {
  return logger.child({ requestId, ...bindings })
}
