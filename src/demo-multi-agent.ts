/**
 * Demo3：多子智能体协作
 * 演示：主智能体 Planning → 子智能体并行执行 → 汇总输出报告
 * 运行命令：npm run demo:multi
 * Tavily Key 可选（没有也能运行，使用内置知识）
 */
import 'dotenv/config'
import { createAgent, type DeepAgent } from './agent.js'
import { TavilySearch } from './tools/tavily-search.js'
// ─── 子智能体 A：技术研究员 ────────────────────────────────
// 职责：搜索收集技术资料
async function researcherAgent(
  topic: string,
  search: TavilySearch,
): Promise<string> {
  console.log(`\n[Researcher] 开始搜索：${topic}`)

  const results = await search.search(topic, 3)

  if (results.length === 0) {
    return `（搜索「${topic}」未获得结果）`
  }

  const summary = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
    .join('\n\n')

  console.log(`[Researcher] 搜索完成，获取 ${results.length} 条结果`)
  return summary
}
// ─── 子智能体 B：内容分析师 ────────────────────────────────
// 职责：用 DeepSeek 对原始资料做分析，提取核心观点
async function analystAgent(
  agent: DeepAgent,
  rawData: string,
  aspect: string,
): Promise<string> {
  console.log(`\n[Analyst] 开始分析：${aspect}`)

  const result = await agent.invoke(`
请分析以下资料，提取关于「${aspect}」的核心观点。
用简洁的要点形式输出，3-5个要点，每点 1-2 句话。

格式：
## ${aspect}
- 要点1：...
- 要点2：...
- 要点3：...

待分析资料：
${rawData}
`)

  console.log(`[Analyst] 分析完成：${aspect}`)
  return result.content
}
// ─── 子智能体 C：文档写手 ──────────────────────────────────
// 职责：把各部分分析结果整合成完整的调研报告，写入文件
async function writerAgent(
  agent: DeepAgent,
  sections: Record<string, string>,
  title: string,
): Promise<void> {
  console.log(`\n[Writer] 开始整合报告：${title}`)

  const sectionsText = Object.entries(sections)
    .map(([key, value]) => `${value}`)
    .join('\n\n')

  const result = await agent.invoke(`
请将以下各部分内容整合成一份完整、专业的技术调研报告。

报告标题：${title}

各部分内容：
${sectionsText}

要求：
1. 补充一段 100 字左右的报告摘要
2. 正文保留各部分的要点
3. 结尾加上「结论」部分，50字以内
4. 使用 Markdown 格式

将完整报告写入文件：
\`\`\`filename:tech-research-report.md
（在这里填写完整报告内容）
\`\`\`
`)

  // 模型偶尔只返回 Markdown 正文而不返回 filename 代码块；此时由编排层兜底写入，
  // 确保 Demo 的最终产物不依赖模型是否严格遵循文件块格式。
  if (!result.filesWritten.includes('tech-research-report.md')) {
    const reportContent = result.content
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    agent.writeFile('tech-research-report.md', reportContent)
    console.log('[Writer] 模型未返回文件块，已将报告正文兜底写入文件')
  }

  console.log('[Writer] 报告整合完成')
}
// ─── 主智能体编排 ─────────────────────────────────────────
async function main() {
  // 检查 Tavily Key（可选）
  if (!process.env.TAVILY_API_KEY) {
    console.warn(
      '⚠️  未配置 TAVILY_API_KEY，将使用内置知识运行（跳过网络搜索）',
    )
  }

  // 创建主 Agent（用于分析和写作阶段）
  const mainAgent = await createAgent({
    name: 'DeepAgent - 主智能体',
    skillDir: '.deepagent/skills',
    sandbox: {
      workspacePath: process.cwd(),
      outputDir: 'output',
      verbose: true,
    },
    hitl: { enabled: false },
  })

  // 搜索工具（可选）
  const search = process.env.TAVILY_API_KEY
    ? new TavilySearch(process.env.TAVILY_API_KEY)
    : null

  const reportTitle = '2025年前端 AI 智能体开发技术调研报告'

  // 主智能体 Planning：打印任务拆解计划
  console.log(`\n🚀 主智能体开始 Planning`)
  console.log(`📋 任务：${reportTitle}`)
  console.log('📌 任务拆解：')
  console.log('  Step 1 → Researcher Agent：并行搜索两个技术方向（同时执行）')
  console.log('  Step 2 → Analyst Agent：并行分析两个维度（两个实例同时运行）')
  console.log('  Step 3 → Writer Agent：整合所有分析，生成完整报告')

  // ── Step 1：并行搜索 ──────────────────────────────────
  console.log('\n' + '='.repeat(50))
  console.log('Step 1：Researcher 并行搜索阶段')
  console.log('（两个搜索任务同时执行，谁先完成谁先打印日志）')
  console.log('='.repeat(50))

  // 内置知识（没有 Tavily 时使用）
  let frameworkData = `
LangChain 是 AI 开发的基础框架，统一了各家模型的接口。
LangGraph 在 LangChain 基础上支持有状态的复杂工作流，解决循环和分支问题。
Deep Agent 底层基于 LangGraph，面向通用型智能体场景，开箱即用。
三者是层层递进的关系，轻量场景用 LangChain，复杂状态用 LangGraph，通用智能体用 Deep Agent。
  `
  let scenarioData = `
前端工程师做 AI 应用有天然优势：TypeScript 是 AI 开发的主流语言之一，UI 能力是 AI 应用落地的关键。
纯 Python AI 工程师做不了高质量的前端界面，纯前端工程师不熟悉 AI 开发。
前端 + AI 的复合能力是当前最稀缺的技能组合，岗位需求大，薪资溢价明显。
  `

  if (search) {
    // 用 Promise.all 并行执行两个搜索任务
    // 两个任务同时开始，都完成后才进入下一步
    ;[frameworkData, scenarioData] = await Promise.all([
      researcherAgent(
        'LangChain LangGraph Deep Agent framework comparison 2025',
        search,
      ),
      researcherAgent(
        'frontend engineer AI development TypeScript agent 2025',
        search,
      ),
    ])
  } else {
    console.log('[Researcher A] 使用内置知识（框架对比）')
    console.log('[Researcher B] 使用内置知识（前端AI机遇）')
  }

  // ── Step 2：并行分析 ──────────────────────────────────
  console.log('\n' + '='.repeat(50))
  console.log('Step 2：Analyst 并行分析阶段')
  console.log('（两个 Agent 实例同时分析，模拟子智能体并行）')
  console.log('='.repeat(50))

  // 创建第二个 Agent 实例，用于并行分析
  // 两个实例同时调用 DeepSeek，不互相阻塞
  const analystAgentInstance = await createAgent({
    name: 'DeepAgent - 分析师',
    skillDir: '.deepagent/skills',
    sandbox: {
      workspacePath: process.cwd(),
      outputDir: 'output',
      verbose: false, // 子智能体关闭日志，避免混乱
    },
    hitl: { enabled: false },
  })

  // 两个分析任务并行执行
  const [frameworkAnalysis, scenarioAnalysis] = await Promise.all([
    analystAgent(mainAgent, frameworkData, '框架选型与对比'),
    analystAgent(
      analystAgentInstance,
      scenarioData,
      '前端工程师的 AI 发展机遇',
    ),
  ])

  // ── Step 3：整合报告 ──────────────────────────────────
  console.log('\n' + '='.repeat(50))
  console.log('Step 3：Writer 整合报告阶段')
  console.log('='.repeat(50))

  await writerAgent(
    mainAgent,
    {
      框架选型与对比: frameworkAnalysis,
      '前端工程师的 AI 发展机遇': scenarioAnalysis,
    },
    reportTitle,
  )

  // ── 汇总展示结果 ──────────────────────────────────────
  const sandbox = mainAgent.getSandbox()
  if (sandbox) {
    const files = sandbox.listFiles()
    console.log('\n' + '='.repeat(50))
    console.log('🎉 多智能体协作完成！')
    console.log('='.repeat(50))
    console.log('\n📂 生成的文件：')
    files.forEach((f: any) => console.log(`  ✅ output/${f}`))

    const report = sandbox.readFile('tech-research-report.md')
    if (report) {
      console.log('\n📖 报告预览（前 500 字）：')
      console.log('─'.repeat(50))
      console.log(report.slice(0, 500) + (report.length > 500 ? '\n...' : ''))
      console.log('─'.repeat(50))
    }
  }
}
main().catch(console.error)
