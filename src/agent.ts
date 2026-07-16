/**
 * 通用智能体核心模块。
 * 负责 DeepSeek 调用、Skill 加载、沙箱文件写入及 HITL 检查。
 */
import OpenAI from 'openai'
import {
  type SandboxConfig,
  type SandboxContent,
  createSandBox,
} from './sandbox.js'
import { type HitlConfig, hitlCheckpoint } from './hitl.js'
import { type Skill, loadSkills, buildSkillsPrompt } from './skill-loader.js'

export interface AgentConfig {
  name: string
  model?: string
  apiKey?: string
  temperature?: number
  skillDir?: string
  sandbox?: SandboxConfig
  hitl?: HitlConfig
  systemPrompt?: string
  maxToken?: number
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentResult {
  content: string
  message: AgentMessage[]
  filesWritten: string[]
}

/** 构造完成后的配置，避免业务代码反复处理可选值。 */
interface ResolvedAgentConfig {
  name: string
  model: string
  apiKey: string
  temperature: number
  skillDir: string
  sandbox: SandboxConfig
  hitl: HitlConfig
  systemPrompt: string
  maxToken: number
}

export class DeepAgent {
  private client: OpenAI
  private config: ResolvedAgentConfig
  private skills: Skill[] = []
  private sandbox: SandboxContent | null = null
  private conversationHistory: AgentMessage[] = []

  constructor(config: AgentConfig) {
    this.config = {
      name: config.name,
      model: config.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '',
      temperature:
        config.temperature ?? Number(process.env.DEEPSEEK_TEMPERATURE ?? 0.7),
      skillDir: config.skillDir ?? '.deepagent/skills',
      sandbox: config.sandbox ?? {
        workspacePath: process.cwd(),
        outputDir: 'output',
        verbose: true,
      },
      hitl: config.hitl ?? { enabled: true, autoApprove: false },
      systemPrompt: config.systemPrompt ?? '',
      maxToken: config.maxToken ?? 4096,
    }

    if (!this.config.apiKey) {
      throw new Error('缺少 DEEPSEEK_API_KEY，请在 .env 中配置后重试。')
    }

    // DeepSeek 兼容 OpenAI API，因此直接复用 OpenAI SDK。
    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: 'https://api.deepseek.com/v1',
    })
  }

  async init(): Promise<void> {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`🤖 ${this.config.name} 启动中...`)
    console.log(`${'='.repeat(50)}`)

    console.log('\n📂 [Agent] 正在加载 Skill 文件...')
    this.skills = loadSkills(this.config.skillDir)
    console.log(`[Agent] 共加载 ${this.skills.length} 个 Skill`)

    console.log('\n🔒 [Agent] 正在初始化沙箱...')
    this.sandbox = createSandBox(this.config.sandbox)

    console.log(`\n✅ [Agent] 初始化完成，模型：${this.config.model}`)
    console.log(`${'='.repeat(50)}\n`)
  }

  private buildSystemPrompt(): string {
    const skillsSection = buildSkillsPrompt(this.skills)
    const sandboxSection = this.sandbox
      ? `\n## 工作区信息\n当前输出目录：${this.sandbox.outputDir}\n所有文件操作都写入此目录。`
      : ''

    return `你是 ${this.config.name}，一个基于 DeepSeek 的通用型 AI 智能体。

## 核心能力
- 理解用户的自然语言目标，自动规划执行步骤
- 调用相应的 Skill 技能处理专项任务
- 将结果写入本地文件系统
${skillsSection}
${sandboxSection}

## 行为准则
- 每次回复说明你正在做什么（Planning → 执行 → 输出）
- 需要写文件时，使用以下格式：
\`\`\`filename:文件名.md
文件内容
\`\`\`
- 使用中文回复

${this.config.systemPrompt}`
  }

  /** 提取模型返回的文件代码块，并在 HITL 放行后写入沙箱。 */
  private async processFileOperations(content: string): Promise<string[]> {
    if (!this.sandbox) return []

    const filesWritten: string[] = []
    const fileBlockRegex = /```(?:filename:|file:)([^\n]+)\n([\s\S]*?)```/g
    let match: RegExpExecArray | null

    while ((match = fileBlockRegex.exec(content)) !== null) {
      const filename = match[1].trim()
      const fileContent = match[2].trim()

      try {
        const approved = await hitlCheckpoint(
          `写入文件：${filename}`,
          this.config.hitl,
        )
        if (approved) {
          const writtenPath = this.sandbox.writeFile(filename, fileContent)
          filesWritten.push(filename)
          console.log(`[Agent] ✅ 已写入：${writtenPath}`)
        }
      } catch (error) {
        console.error(`[Agent] ❌ 写入失败 ${filename}:`, error)
      }
    }

    return filesWritten
  }

  async invoke(userMessage: string): Promise<AgentResult> {
    const approved = await hitlCheckpoint(userMessage, this.config.hitl)
    if (!approved) {
      return {
        content: '操作已被用户取消。',
        message: this.conversationHistory,
        filesWritten: [],
      }
    }

    this.conversationHistory.push({ role: 'user', content: userMessage })
    console.log(
      `\n📨 [Agent] 收到任务：${userMessage.slice(0, 80)}${userMessage.length > 80 ? '...' : ''}`,
    )
    console.log('[Agent] 正在思考...\n')

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxToken,
      temperature: this.config.temperature,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        ...this.conversationHistory,
      ],
    })

    const assistantContent = response.choices[0]?.message?.content ?? ''
    this.conversationHistory.push({
      role: 'assistant',
      content: assistantContent,
    })
    const filesWritten = await this.processFileOperations(assistantContent)

    console.log('\n' + '─'.repeat(50))
    console.log('🎯 [Agent] 执行完成')
    if (filesWritten.length > 0) {
      console.log(`📄 写入文件：${filesWritten.join(', ')}`)
    }

    return {
      content: assistantContent,
      message: this.conversationHistory,
      filesWritten,
    }
  }

  async invokeStream(userMessage: string): Promise<AgentResult> {
    const approved = await hitlCheckpoint(userMessage, this.config.hitl)
    if (!approved) {
      return {
        content: '操作已被用户取消。',
        message: this.conversationHistory,
        filesWritten: [],
      }
    }

    this.conversationHistory.push({ role: 'user', content: userMessage })
    console.log(
      `\n📨 [Agent] 收到任务：${userMessage.slice(0, 80)}${userMessage.length > 80 ? '...' : ''}`,
    )
    console.log('[Agent] 开始流式输出：\n')
    console.log('─'.repeat(50))

    let fullContent = ''
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxToken,
      temperature: this.config.temperature,
      stream: true,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        ...this.conversationHistory,
      ],
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      if (delta) {
        process.stdout.write(delta)
        fullContent += delta
      }
    }

    console.log('\n' + '─'.repeat(50))
    this.conversationHistory.push({ role: 'assistant', content: fullContent })
    const filesWritten = await this.processFileOperations(fullContent)

    console.log('\n✅ [Agent] 流式执行完成')
    if (filesWritten.length > 0) {
      console.log(`📄 写入文件：${filesWritten.join(', ')}`)
    }

    return {
      content: fullContent,
      message: this.conversationHistory,
      filesWritten,
    }
  }

  writeFile(filename: string, content: string): string {
    if (!this.sandbox) throw new Error('沙箱未初始化')
    return this.sandbox.writeFile(filename, content)
  }

  getSandbox(): SandboxContent | null {
    return this.sandbox
  }

  clearHistory(): void {
    this.conversationHistory = []
    console.log('[Agent] 对话历史已清空')
  }

  getSkills(): Skill[] {
    return this.skills
  }
}

/** 工厂函数：创建并初始化智能体。保留原名称以兼容现有 Demo。 */
export async function creatAgent(config: AgentConfig): Promise<DeepAgent> {
  const agent = new DeepAgent(config)
  await agent.init()
  return agent
}
