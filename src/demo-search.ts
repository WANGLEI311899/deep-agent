/**
 * Demo2：搜索 + 写文件完整链路
 * 演示：Tavily 搜索 → DeepSeek 加工总结 → 写入本地文件
 * 运行命令：npm run demo:search
 * 需要：TAVILY_API_KEY 环境变量
 */
import 'dotenv/config'
import { createAgent } from './agent.js'
import { TavilySearch } from './tools/tavily-search.js'

async function main() {
  // 检查 Tavily Key 是否配置
  if (!process.env.TAVILY_API_KEY) {
    console.error('❌ 缺少 TAVILY_API_KEY，请在 .env 文件中配置')
    console.log('   获取地址：https://app.tavily.com/（免费每月 1000 次）')
    process.exit(1)
  }

  // 初始化搜索工具
  const search = new TavilySearch(process.env.TAVILY_API_KEY)
  // 初始化 Agent
  const agent = await createAgent({
    name: 'deepCodex - 搜索版',
    skillDir: '.deepcodex/skills',
    sandbox: {
      workspacePath: process.cwd(),
      outputDir: 'output',
      verbose: true,
    },
    hitl: { enabled: false },
    systemPrompt: `
你具备网络搜索能力，我会把搜索结果提供给你。
需要写文件时请用以下格式：
\`\`\`filename:文件名.md
文件内容
\`\`\`
`,
  })
  // 第一步：搜索
  const query = 'LangChain Deep Agent tutorial getting started 2025'
  console.log(`\n🔍 第一步：搜索关键词「${query}」`)
  const searchResults = await search.search(query, 5)

  if (searchResults.length === 0) {
    console.warn('搜索结果为空，可能是网络问题或 Key 无效')
    process.exit(1)
  }

  console.log(`[Search] 获取到 ${searchResults.length} 条结果：`)
  searchResults.forEach((r, i) => {
    console.log(`  [${i + 1}] ${r.title}（相关性：${r.score.toFixed(2)}）`)
  })
  // 第二步：把搜索结果 + 指令一起发给 DeepSeek
  console.log('\n🤖 第二步：DeepSeek 处理搜索结果，生成中文笔记')

  const userMessage = `
请根据以下搜索结果，总结 LangChain Deep Agent 的核心概念和快速入门步骤。
用中文写成学习笔记，结构清晰，包含：
1. 核心概念（2-3个）
2. 快速入门步骤（3-5步）
3. 注意事项

写完后保存到文件 deep-codex-notes.md。

以下是搜索到的资料：
${searchResults
  .map(
    (r, i) =>
      `[${i + 1}] 标题：${r.title}
来源：${r.url}
内容：${r.content}`,
  )
  .join('\n\n---\n\n')}
`

  const result = await agent.invokeStream(userMessage)
  // 如果 AI 没有自动用 filename 格式输出文件，手动保存
  if (result.filesWritten.length === 0) {
    console.log('\n⚠️  AI 没有使用 filename 格式，手动保存内容...')
    const sandbox = agent.getSandbox()
    if (sandbox) {
      sandbox.writeFile('deep-codex-notes.md', result.content)
    }
  }
  // 第三步：展示结果
  console.log('\n📄 第三步：查看生成的文件')
  const sandbox = agent.getSandbox()
  if (sandbox) {
    const content = sandbox.readFile('deep-codex-notes.md')
    if (content) {
      console.log('\n文件内容预览（前 400 字）：')
      console.log('─'.repeat(50))
      console.log(content.slice(0, 400) + (content.length > 400 ? '\n...' : ''))
      console.log('─'.repeat(50))
      console.log('\n完整文件位置：output/deep-codex-notes.md')
    }
  }
}
main().catch(console.error)
