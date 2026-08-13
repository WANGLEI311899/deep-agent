import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { calculateRetrievalMetrics } from '../dist/rag/evaluation.mjs'
import { WorkspaceRagService } from '../dist/rag/workspace-rag.mjs'
import { extractWorkspaceRagQuery } from '../dist/tools/workspace-rag-tool.mjs'

test('RAG 检索指标正确计算来源命中与排名', () => {
  const metrics = calculateRetrievalMetrics(
    ['docs/other.md', 'docs/guide.md', 'README.md'],
    ['guide.md', 'README.md'],
  )
  assert.equal(metrics.hitRate, 1)
  assert.equal(metrics.reciprocalRank, 0.5)
  assert.equal(metrics.precisionAtK, 2 / 3)
  assert.equal(metrics.recallAtK, 1)
})

test('只有明确的工作区知识查询才触发 RAG 工具', () => {
  assert.deepEqual(extractWorkspaceRagQuery('根据工作区资料，部署步骤是什么？'), {
    query: '部署步骤是什么',
  })
  assert.equal(extractWorkspaceRagQuery('今天天气怎么样？'), null)
})

test('LlamaIndex 能构建并重新加载工作区持久化索引', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepcodex-rag-'))
  const workspace = path.join(root, 'workspace')
  const cacheRoot = path.join(root, 'cache')
  await fs.mkdir(workspace)
  await fs.writeFile(
    path.join(workspace, 'guide.md'),
    '# 部署指南\n\n生产环境使用 npm start，并设置访问口令。',
    'utf8',
  )

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const data = inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: [String(text).length / 100, 1, 0.5, 0.25],
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data, model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })

  const config = {
    enabled: true,
    embeddingApiKey: 'test-key',
    embeddingBaseUrl: baseUrl,
    embeddingModel: 'test-embedding',
    topK: 3,
    chunkSize: 128,
    chunkOverlap: 20,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    maxFiles: 20,
    refreshIntervalMs: 1,
    cacheRoot,
    extensions: new Set(['.md']),
    ignoredDirectories: new Set(['.git']),
    ignoredFiles: new Set(['package-lock.json']),
  }
  const first = new WorkspaceRagService(workspace, config)
  const built = await first.query('生产环境如何部署？')
  assert.equal(built.refreshed, true)
  assert.equal(built.sources[0].path, 'guide.md')

  // 新实例模拟进程重启，应复用磁盘索引而不是重新 embedding 文档。
  const second = new WorkspaceRagService(workspace, config)
  const loaded = await second.query('访问口令怎么设置？')
  assert.equal(loaded.refreshed, false)
  assert.equal(loaded.sources[0].path, 'guide.md')
})
