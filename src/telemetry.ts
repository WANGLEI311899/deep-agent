import * as Sentry from '@sentry/node'
import { logger } from './logger.js'

let enabled = false

/** 配置了 DSN 才启用，确保本地开发和未配置的部署不产生外部数据传输。 */
export function initTelemetry(): boolean {
  const dsn = process.env.SENTRY_DSN?.trim()
  if (!dsn) {
    logger.info({ event: 'sentry.disabled' }, 'Sentry 未配置')
    return false
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || process.env.APP_VERSION,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    sendDefaultPii: false,
    beforeSend(event) {
      // 本项目默认不采集用户输入、模型输出和本机路径。
      if (event.request) {
        delete event.request.data
        delete event.request.cookies
        delete event.request.headers
      }
      return event
    },
  })
  enabled = true
  logger.info({ event: 'sentry.enabled' }, 'Sentry 已启用')
  return true
}

export function captureException(
  error: unknown,
  context: Record<string, unknown>,
): string | undefined {
  if (!enabled) return undefined
  return Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context)) {
      if (['requestId', 'sessionId', 'userId', 'stage', 'code'].includes(key)) {
        scope.setTag(key, String(value))
      } else {
        scope.setExtra(key, value)
      }
    }
    return Sentry.captureException(error)
  })
}

export async function flushTelemetry(timeoutMs = 2_000): Promise<boolean> {
  return enabled ? Sentry.flush(timeoutMs) : true
}
