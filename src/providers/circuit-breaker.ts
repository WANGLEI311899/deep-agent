/**
 * 供应商级熔断器：额度、限流或计费错误出现后，短时间内跳过故障端点。
 * 状态只保存在当前进程内；服务重启后会重新探测，避免永久误判。
 */
export class ProviderCircuitBreaker {
  private openUntil = 0

  constructor(private readonly cooldownMs = 5 * 60_000) {}

  canAttempt(): boolean {
    return Date.now() >= this.openUntil
  }

  remainingMs(): number {
    return Math.max(0, this.openUntil - Date.now())
  }

  recordSuccess(): void {
    this.openUntil = 0
  }

  recordFailure(error: unknown): void {
    if (isQuotaOrRateLimitError(error)) this.openUntil = Date.now() + this.cooldownMs
  }
}

const breakers = new Map<string, ProviderCircuitBreaker>()

export function getProviderCircuitBreaker(key: string): ProviderCircuitBreaker {
  let breaker = breakers.get(key)
  if (!breaker) {
    breaker = new ProviderCircuitBreaker()
    breakers.set(key, breaker)
  }
  return breaker
}

/** 兼容 OpenAI SDK 错误和 OpenAI-compatible 服务返回的普通 Error。 */
export function isQuotaOrRateLimitError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string; message?: string }
  const message = `${candidate?.code ?? ''} ${candidate?.message ?? String(error)}`.toLowerCase()
  return candidate?.status === 429 || /insufficient_quota|quota|billing|credit|rate.?limit|too many requests/.test(message)
}

