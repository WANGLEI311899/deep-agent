import test from 'node:test'
import assert from 'node:assert/strict'
import { FallbackVisionAnalyzer } from '../dist/multimodal/media-service.mjs'
import { ProviderCircuitBreaker, isQuotaOrRateLimitError } from '../dist/providers/circuit-breaker.mjs'

test('视觉供应商失败后按顺序切换到下一服务', async () => {
  const calls = []
  const analyzer = new FallbackVisionAnalyzer([
    { isConfigured: () => true, analyze: async () => { calls.push('openai'); throw Object.assign(new Error('insufficient_quota'), { status: 429 }) } },
    { isConfigured: () => true, analyze: async () => { calls.push('ollama'); return { text: '本地视觉结果', provider: 'Ollama', model: 'test-vl' } } },
  ])
  const result = await analyzer.analyze({ filename: 'x.png', mimeType: 'image/png', buffer: Buffer.from('x'), instruction: 'test' })
  assert.deepEqual(calls, ['openai', 'ollama'])
  assert.equal(result.provider, 'Ollama')
})

test('额度和限流错误会打开熔断器', () => {
  assert.equal(isQuotaOrRateLimitError(Object.assign(new Error('insufficient_quota'), { status: 429 })), true)
  const breaker = new ProviderCircuitBreaker(10_000)
  breaker.recordFailure(Object.assign(new Error('rate limit'), { status: 429 }))
  assert.equal(breaker.canAttempt(), false)
  assert.ok(breaker.remainingMs() > 0)
  breaker.recordSuccess()
  assert.equal(breaker.canAttempt(), true)
})
