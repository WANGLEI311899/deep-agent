import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AppError,
  ErrorCodes,
  errorResponse,
  normalizeError,
} from '../dist/errors.mjs'

test('标准错误响应包含稳定错误码、阶段和 requestId', () => {
  const error = new AppError(
    ErrorCodes.AgentBusy,
    'Agent 正忙',
    429,
    'agent_queue',
    true,
  )

  assert.deepEqual(errorResponse(error, 'req-test-123'), {
    error: 'Agent 正忙',
    code: 'AGENT_BUSY',
    stage: 'agent_queue',
    retryable: true,
    requestId: 'req-test-123',
  })
})

test('模型超时被归一化为可重试的 LLM_TIMEOUT', () => {
  const error = normalizeError(new Error('DeepSeek timeout'), 'llm_generate')
  assert.equal(error.code, ErrorCodes.LlmTimeout)
  assert.equal(error.statusCode, 504)
  assert.equal(error.retryable, true)
})

test('未知异常不向客户端泄露原始错误消息', () => {
  const error = normalizeError(new Error('database password=secret'))
  assert.equal(error.code, ErrorCodes.InternalError)
  assert.doesNotMatch(error.message, /secret/)
})
