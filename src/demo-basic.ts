// 基因skill的调用
// 1.加载技能文件，构建系统提示词
// 2.构建系统提示词，包含技能说明，沙箱说明
// 3.调用模型接口 获取回复，解析回复中的文件输出指令 写入文件
import 'dotenv/config'
import { createAgent } from './agent.js'
async function main() {
  const agent = await createAgent({
    name: 'deepCodex 基础版（Skill 调用）',
    skillDir: '.deepcodex/skills',
    sandbox: {
      workspacePath: process.cwd(),
      outputDir: 'output',
      verbose: true,
    },
    hitl: {
      enabled: true,
    },
    systemPrompt: '这是一个古诗词的skill，擅长处理古诗词',
  })
  // 打印已加载的 Skill 列表
  console.log('📋 已加载的 Skill：')
  agent.getSkills().forEach((skill) => {
    console.log(`  - ${skill.name}（${skill.fileName}）`)
  })

  // 测试一：输入诗词，验证「唐宋诗词笑话生成器」Skill 触发
  console.log('\n🎭 测试一：诗词笑话生成\n')
  const result1 = await agent.invoke('飞流直下三千尺，疑是银河落九天')
  console.log('\n📝 AI 回复：')
  console.log(result1.content)

  // 测试二：另一首诗，验证同一个 Skill 对不同输入的处理
  console.log('\n🎭 测试二：另一首诗\n')
  const result2 = await agent.invoke('举头望明月，低头思故乡')
  console.log('\n📝 AI 回复：')
  console.log(result2.content)

  // 测试三：输入代码，验证「代码审查助手」Skill 触发
  console.log('\n🔍 测试三：代码审查\n')
  const result3 = await agent.invoke(`
帮我审查这段代码：
const data = await fetch('/api/users')
const users = data.json()
console.log(users)
`)
  console.log('\n📝 AI 回复：')
  console.log(result3.content)
  // 展示沙箱状态
  const sandbox = agent.getSandbox()
  if (sandbox) {
    const files = sandbox.listFiles()
    if (files.length > 0) {
      console.log('\n📂 沙箱输出文件：')
      files.forEach((f) => console.log(`  - output/${f}`))
    } else {
      console.log('\n📂 本次演示没有生成文件（AI 没有使用 filename 格式输出）')
    }
  }
}

main().catch(console.error)
