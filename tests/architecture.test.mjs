import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillRegistry } from '../dist/skill-loader.mjs'
import { ToolRegistry } from '../dist/tool-registry.mjs'
import { SessionStore } from '../dist/sessions.mjs'

test('Skill 路由后注入完整 Script，未命中时不注入', () => {
  const registry = new SkillRegistry([
    {
      name: '代码审查',
      fileName: 'review.skill.md',
      description: '审查 TypeScript 代码',
      script: '第一步检查类型，第二步检查异常处理。',
      raw: '',
    },
  ])
  const matched = registry.match('请帮我做 TypeScript 代码审查')
  assert.equal(matched.length, 1)
  assert.match(registry.buildExecutionPrompt(matched), /第一步检查类型/)
  assert.equal(registry.buildExecutionPrompt([]), '')
})

test('Tool Registry 传递取消信号并执行匹配工具', async () => {
  const registry = new ToolRegistry({ defaultTimeoutMs: 1_000 })
  registry.register({
    name: 'echo',
    description: '回显',
    riskLevel: 'low',
    match: (message) => (message.startsWith('echo ') ? message.slice(5) : null),
    execute: async (input, context) => {
      assert.equal(context.signal.aborted, false)
      return String(input)
    },
  })
  const controller = new AbortController()
  const [{ tool, input }] = registry.match('echo hello')
  const result = await registry.execute(tool, input, {
    signal: controller.signal,
  })
  assert.equal(result.output, 'hello')
})

test('SessionStore 按 userId 隔离读取、列表和删除', () => {
  const store = new SessionStore({ persist: false })
  const alice = store.create('alice')
  const bob = store.create('bob')

  assert.equal(store.get(alice.id, 'bob'), undefined)
  assert.equal(store.get(bob.id, 'alice'), undefined)
  assert.deepEqual(store.list('alice').map((item) => item.id), [alice.id])
  assert.equal(store.delete(alice.id, 'bob'), false)
  assert.equal(store.delete(alice.id, 'alice'), true)
})

test('Tool Registry 在超时后取消慢工具', async () => {
  const registry = new ToolRegistry({ defaultTimeoutMs: 20 })
  registry.register({
    name: 'slow',
    description: '慢工具',
    riskLevel: 'low',
    match: () => ({}),
    execute: async (_input, context) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 500)
        context.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(context.signal.reason)
          },
          { once: true },
        )
      }),
  })
  const [{ tool, input }] = registry.match('run')
  await assert.rejects(
    registry.execute(tool, input, {
      signal: new AbortController().signal,
    }),
  )
})
