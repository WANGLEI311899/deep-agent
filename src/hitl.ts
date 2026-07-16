// hitl  人为参与机制

// 当智能体执行到高危操作时，主动中断等待人的确定
// import process from "process";
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
export interface HitlConfig {
  /** 是否开启 HITL，默认 true */
  enabled?: boolean
  /** 追加自定义高风险关键词 */
  extraKeywords?: string[]
  /** 自动同意所有操作，用于自动化测试，生产环境不要开 */
  autoApprove?: boolean
}

// 第一个方法 检测操作内容 是否含有高风险提示词
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

// 第二个方法等待用户在终端输入确定
/**
 * 在终端等待用户输入 y/n
 * 使用 readline 模块实现交互式输入
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
 * 在执行高风险操作前调用
 * 返回 true 表示允许继续，false 表示用户拒绝
 */
export async function hitlCheckpoint(
  operationDesc: string,
  config: HitlConfig = {},
): Promise<boolean> {
  const { enabled = true, extraKeywords = [], autoApprove = false } = config
  // HITL 关闭时直接放行
  if (!enabled) return true
  // 不包含高风险词时直接放行
  if (!isHighRiskOperation(operationDesc, extraKeywords)) return true
  // 打印警告信息
  console.log('\n' + '='.repeat(50))
  console.log('⚠️  [HITL] 检测到高风险操作，需要人工确认')
  console.log('='.repeat(50))
  console.log(`操作描述：${operationDesc}`)
  console.log('='.repeat(50))
  // 自动同意模式（测试用）
  if (autoApprove) {
    console.log('[HITL] 自动同意模式，继续执行...\n')
    return true
  }
  // 等待用户输入
  const approved = await waitForConfirmation('\n请确认是否继续执行？(y/n): ')
  if (approved) {
    console.log('[HITL] 已确认，继续执行...\n')
  } else {
    console.log('[HITL] 已拒绝，操作中止。\n')
  }
  return approved
}
