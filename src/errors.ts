/**
 * 对外稳定的错误码。错误消息可以调整，调用方应始终使用 code 判断类型。
 */
export const ErrorCodes = {
  InvalidRequest: 'INVALID_REQUEST',
  AuthRequired: 'AUTH_REQUIRED',
  AuthInvalid: 'AUTH_INVALID',
  RateLimited: 'RATE_LIMITED',
  SessionNotFound: 'SESSION_NOT_FOUND',
  AgentBusy: 'AGENT_BUSY',
  LlmAuthFailed: 'LLM_AUTH_FAILED',
  LlmRateLimited: 'LLM_RATE_LIMITED',
  LlmTimeout: 'LLM_TIMEOUT',
  LlmStreamInterrupted: 'LLM_STREAM_INTERRUPTED',
  ToolTimeout: 'TOOL_TIMEOUT',
  ToolFailed: 'TOOL_FAILED',
  HitlRejected: 'HITL_REJECTED',
  HitlTimeout: 'HITL_TIMEOUT',
  FilePathBlocked: 'FILE_PATH_BLOCKED',
  FileWriteFailed: 'FILE_WRITE_FAILED',
  SessionPersistFailed: 'SESSION_PERSIST_FAILED',
  ClientDisconnected: 'CLIENT_DISCONNECTED',
  WorkspaceLocked: 'WORKSPACE_LOCKED',
  NotFound: 'NOT_FOUND',
  InternalError: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = 500,
    public readonly stage = 'unknown',
    public readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AppError'
  }
}

/** 将 SDK、网络和内部异常转换成不会泄露密钥或实现细节的标准错误。 */
export function normalizeError(error: unknown, stage = 'unknown'): AppError {
  if (error instanceof AppError) return error

  const source = error instanceof Error ? error : new Error(String(error))
  const message = source.message.toLowerCase()
  const status = Number((error as { status?: number })?.status ?? 0)

  if (stage === 'llm_generate' || message.includes('deepseek')) {
    if (status === 401 || status === 403) {
      return new AppError(ErrorCodes.LlmAuthFailed, '模型服务认证失败。', 502, stage, false, { cause: source })
    }
    if (status === 429) {
      return new AppError(ErrorCodes.LlmRateLimited, '模型服务请求过于频繁，请稍后重试。', 503, stage, true, { cause: source })
    }
    if (message.includes('timeout') || message.includes('超时')) {
      return new AppError(ErrorCodes.LlmTimeout, '模型响应超时，请稍后重试。', 504, stage, true, { cause: source })
    }
    return new AppError(ErrorCodes.LlmStreamInterrupted, '模型响应中断，请稍后重试。', 502, stage, true, { cause: source })
  }

  if (message.includes('客户端已断开') || message.includes('aborted')) {
    return new AppError(ErrorCodes.ClientDisconnected, '客户端已断开连接。', 499, stage, true, { cause: source })
  }
  if (message.includes('路径越界')) {
    return new AppError(ErrorCodes.FilePathBlocked, '目标路径超出允许的输出目录。', 400, stage, false, { cause: source })
  }

  return new AppError(ErrorCodes.InternalError, '服务暂时不可用，请稍后重试。', 500, stage, false, { cause: source })
}

export interface ErrorResponse {
  error: string
  code: ErrorCode
  stage: string
  retryable: boolean
  requestId: string
}

export function errorResponse(error: AppError, requestId: string): ErrorResponse {
  return {
    error: error.message,
    code: error.code,
    stage: error.stage,
    retryable: error.retryable,
    requestId,
  }
}
