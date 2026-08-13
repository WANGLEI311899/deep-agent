import assert from 'node:assert/strict'
import test from 'node:test'
import { isHighRiskOperation, hitlCheckpoint } from '../dist/hitl.mjs'

test('检测高风险 Shell 命令', () => {
  assert.ok(isHighRiskOperation('rm -rf /'))
  assert.ok(isHighRiskOperation('sudo rm something'))
  assert.ok(isHighRiskOperation('chmod 777 file'))
  assert.ok(isHighRiskOperation('dd if=/dev/zero'))
})

test('检测高风险 SQL 操作', () => {
  assert.ok(isHighRiskOperation('drop table users'))
  assert.ok(isHighRiskOperation('drop database main'))
  assert.ok(isHighRiskOperation('delete from users where 1=1'))
  assert.ok(isHighRiskOperation('truncate table logs'))
})

test('检测中文高风险指令', () => {
  assert.ok(isHighRiskOperation('删除所有文件'))
  assert.ok(isHighRiskOperation('清空数据库'))
  assert.ok(isHighRiskOperation('格式化'))
  assert.ok(isHighRiskOperation('强制删除'))
})

test('普通消息不触发高风险', () => {
  assert.equal(isHighRiskOperation('帮我写一首诗'), false)
  assert.equal(isHighRiskOperation('今天天气怎么样'), false)
  assert.equal(isHighRiskOperation('帮我审查这段代码'), false)
})

test('自定义关键词检测', () => {
  assert.ok(isHighRiskOperation('deploy to production', ['deploy']))
  assert.equal(isHighRiskOperation('deploy to production'), false)
})

test('HITL 在 enabled=false 时总是通过', async () => {
  const result = await hitlCheckpoint('rm -rf /', { enabled: false })
  assert.ok(result)
})

test('HITL autoApprove 模式总是通过', async () => {
  const result = await hitlCheckpoint('rm -rf /', {
    enabled: true,
    autoApprove: true,
  })
  assert.ok(result)
})

test('HITL 通过 confirmHandler 获取用户决策', async () => {
  const approved = await hitlCheckpoint('写入文件：test.md', {
    enabled: true,
    confirmFileWrites: true,
    confirmHandler: async () => true,
  }, { type: 'file_write', riskLevel: 'medium' })
  assert.ok(approved)

  const rejected = await hitlCheckpoint('写入文件：test.md', {
    enabled: true,
    confirmFileWrites: true,
    confirmHandler: async () => false,
  }, { type: 'file_write', riskLevel: 'medium' })
  assert.equal(rejected, false)
})

test('HITL 低风险操作不触发确认（无 confirmFileWrites 时）', async () => {
  const result = await hitlCheckpoint('读一个文件', {
    enabled: true,
    autoApprove: false,
    confirmFileWrites: false,
  })
  assert.ok(result)
})
