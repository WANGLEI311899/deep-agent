// hitl  人为参与机制
// 当智能体执行到高危操作或写文件时，主动中断等待人的确认

import readline from 'readline'

/**
 * 内置高风险关键词列表
 * 包含这些词的用户输入会触发确认流程
 */
const HIGH_RISK_KEYWORDS = [
  // Shell 危险命令
  'rm -rf',
  'chmod 777',
  'sudo',
  'dd if=',

  // SQL 危险操作
  'drop table',
  'drop database',
  'delete from',
  'truncate table',

  // 中文危险指令
  '删除所有',
  '清空数据库',
  '格式化',
  '删库',
  '强制删除',
]

export type HitlRiskLevel = 'low' | 'medium' | 'high'

export interface HitlRequestMeta {
  type?: 'user_message' | 'file_write' | 'high_risk' | 'custom'
  detail?: unknown
  riskLevel?: HitlRiskLevel
}

export interface HitlConfig {
  /** 是否开启 HITL，默认 true */
  enabled?: boolean
  /** 追加自定义高风险关键词 */
  extraKeywords?: string[]
  /** 自动同意所有操作，用于自动化测试，生产环境不要开 */
  autoApprove?: boolean
  /**
   * 写文件时是否总是要求确认（Web / Codex 风格默认建议开启）
   * 终端 demo 可关闭，只对高风险关键词确认
   */
  confirmFileWrites?: boolean
  /**
   * 自定义确认处理器（Web UI 注入）。
   * 提供后不再走终端 readline。
   */
  confirmHandler?: (
    operationDesc: string,
    meta?: HitlRequestMeta,
  ) => Promise<boolean>
}

/**
 * 检测输入内容是否包含高风险关键词
 * 对外导出，方便单元测试
 */
export function isHighRiskOperation(
  content: string,
  extraKeywords: string[] = [],
): boolean {
  const keywords = [...HIGH_RISK_KEYWORDS, ...extraKeywords]
  const lower = content.toLowerCase()
  return keywords.some((kw) => lower.includes(kw.toLowerCase()))
}

/**
 * 在终端等待用户输入 y/n
 */
async function waitForConfirmation(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      resolve(trimmed === 'y' || trimmed === 'yes')
    })
  })
}

/**
 * HITL 检查点
 * 在执行高风险操作 / 写文件前调用
 * 返回 true 表示允许继续，false 表示用户拒绝
 */
export async function hitlCheckpoint(
  operationDesc: string,
  config: HitlConfig = {},
  meta: HitlRequestMeta = {},
): Promise<boolean> {
  const {
    enabled = true,
    extraKeywords = [],
    autoApprove = false,
    confirmFileWrites = false,
    confirmHandler,
  } = config

  if (!enabled) return true

  const isFileWrite = meta.type === 'file_write'
  const isHighRisk =
    meta.type === 'high_risk' ||
    isHighRiskOperation(operationDesc, extraKeywords)

  // 默认：仅高风险需要确认；开启 confirmFileWrites 时写文件也确认
  const needsConfirm =
    isHighRisk ||
    (confirmFileWrites && isFileWrite) ||
    meta.type === 'custom'

  if (!needsConfirm) return true

  const riskLevel: HitlRiskLevel =
    meta.riskLevel ?? (isHighRisk ? 'high' : isFileWrite ? 'medium' : 'low')

  console.log('\n' + '='.repeat(50))
  console.log('⚠️  [HITL] 需要人工确认')
  console.log('='.repeat(50))
  console.log(`操作描述：${operationDesc}`)
  console.log(`风险等级：${riskLevel}`)
  console.log('='.repeat(50))

  if (autoApprove) {
    console.log('[HITL] 自动同意模式，继续执行...\n')
    return true
  }

  if (confirmHandler) {
    const approved = await confirmHandler(operationDesc, {
      ...meta,
      riskLevel,
    })
    console.log(
      approved
        ? '[HITL] 用户已确认，继续执行...\n'
        : '[HITL] 用户已拒绝，操作中止。\n',
    )
    return approved
  }

  const approved = await waitForConfirmation('\n请确认是否继续执行？(y/n): ')
  if (approved) {
    console.log('[HITL] 已确认，继续执行...\n')
  } else {
    console.log('[HITL] 已拒绝，操作中止。\n')
  }
  return approved
}
