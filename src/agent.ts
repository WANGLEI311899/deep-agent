/**
 * 通用智能体核心模块。
 * 负责 DeepSeek 调用、Skill 加载、沙箱文件写入、HITL 检查与工具事件流。
 */
import { randomUUID } from 'crypto'
import path from 'path'
import OpenAI from 'openai'
import {
  type SandboxConfig,
  type SandboxContent,
  createSandBox,
} from './sandbox.js'
import {
  type HitlConfig,
  type HitlRequestMeta,
  hitlCheckpoint,
  isHighRiskOperation,
} from './hitl.js'
import { type Skill, loadSkills, buildSkillsPrompt } from './skill-loader.js'
import type { ToolCallEvent, ToolStatus } from './sessions.js'
import {
  OpenMeteoWeather,
  extractWeatherLocation,
} from './tools/open-meteo-weather.js'

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
  /**
   * 喂给模型的对话历史条数上限（user+assistant 合计）。
   * 默认 20（约 10 轮），超出后丢弃最早的消息。
   */
  maxHistoryMessages?: number
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentResult {
  content: string
  message: AgentMessage[]
  filesWritten: string[]
  tools: ToolCallEvent[]
  cancelled?: boolean
}

export interface StreamOptions {
  onChunk?: (delta: string) => void
  onStatus?: (status: string) => void
  onTool?: (tool: ToolCallEvent) => void
  writeToStdout?: boolean
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
  maxHistoryMessages: number
}

function now() {
  return Date.now()
}

export class DeepAgent {
  private client: OpenAI
  private config: ResolvedAgentConfig
  private skills: Skill[] = []
  private sandbox: SandboxContent | null = null
  private conversationHistory: AgentMessage[] = []
  private weather = new OpenMeteoWeather()

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
      maxHistoryMessages:
        config.maxHistoryMessages ??
        Number(process.env.DEEPSEEK_MAX_HISTORY ?? 20),
    }

    if (this.config.maxHistoryMessages < 2) {
      this.config.maxHistoryMessages = 2
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

  /** 运行时覆盖 HITL 配置（Web 注入 confirmHandler） */
  setHitlConfig(hitl: HitlConfig): void {
    this.config.hitl = { ...this.config.hitl, ...hitl }
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

  private buildSystemPrompt(externalContext = ''): string {
    const skillsSection = buildSkillsPrompt(this.skills)
    const sandboxSection = this.sandbox
      ? `\n## 工作区信息\n当前输出目录（绝对路径）：${this.sandbox.outputPath}\n所有通过 filename 代码块写出的文件都会写入此目录（可含子目录）。\n用户若提到「写到桌面 / 某文件夹」，你只需用相对文件名写出即可，系统会落到当前输出目录。`
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

${externalContext ? `\n## 本轮可信工具数据\n${externalContext}\n请基于工具数据回答，并注明数据来源和观测时间；不要编造工具未返回的信息。` : ''}

${this.config.systemPrompt}`
  }

  private emitTool(
    tools: ToolCallEvent[],
    onTool: StreamOptions['onTool'],
    partial: Omit<ToolCallEvent, 'startedAt'> & { startedAt?: number },
  ): ToolCallEvent {
    const existing = tools.find((t) => t.id === partial.id)
    const tool: ToolCallEvent = {
      ...existing,
      ...partial,
      startedAt: existing?.startedAt ?? partial.startedAt ?? now(),
    }
    if (existing) {
      Object.assign(existing, tool)
    } else {
      tools.push(tool)
    }
    onTool?.(tool)
    return tool
  }

  private finishTool(
    tools: ToolCallEvent[],
    onTool: StreamOptions['onTool'],
    id: string,
    status: ToolStatus,
    patch: Partial<ToolCallEvent> = {},
  ): void {
    this.emitTool(tools, onTool, {
      id,
      name: patch.name ?? tools.find((t) => t.id === id)?.name ?? 'tool',
      title: patch.title ?? tools.find((t) => t.id === id)?.title ?? 'tool',
      status,
      ...patch,
      endedAt: now(),
    })
  }

  /** 滑动窗口：只保留最近 N 条消息，避免上下文无限膨胀 */
  private trimHistory(): void {
    const max = this.config.maxHistoryMessages
    if (this.conversationHistory.length > max) {
      const dropped = this.conversationHistory.length - max
      this.conversationHistory = this.conversationHistory.slice(-max)
      // 尽量保证从 user 消息开始，避免残缺 assistant 半截当开头
      if (
        this.conversationHistory.length > 0 &&
        this.conversationHistory[0].role === 'assistant'
      ) {
        this.conversationHistory = this.conversationHistory.slice(1)
      }
      console.log(
        `[Agent] 历史已截断：丢弃最早 ${dropped} 条，当前 ${this.conversationHistory.length} 条`,
      )
    }
  }

  /** 粗粒度匹配可能触发的 Skill，用于工具时间线展示 */
  private matchSkills(userMessage: string): Skill[] {
    const lower = userMessage.toLowerCase()
    return this.skills.filter((skill) => {
      const hay = `${skill.name}\n${skill.description}\n${skill.fileName}`.toLowerCase()
      const tokens = hay
        .split(/[\s,，。；;：:\n/\\()（）【】\[\]|]+/)
        .filter((t) => t.length >= 2)
        .slice(0, 40)
      return tokens.some((t) => lower.includes(t) || t.includes(lower.slice(0, 8)))
    })
  }

  /** 提取模型返回的文件代码块，并在 HITL 放行后写入沙箱。 */
  private async processFileOperations(
    content: string,
    tools: ToolCallEvent[],
    onTool?: StreamOptions['onTool'],
  ): Promise<string[]> {
    if (!this.sandbox) return []

    const filesWritten: string[] = []
    const fileBlockRegex = /```(?:filename:|file:)([^\n]+)\n([\s\S]*?)```/g
    let match: RegExpExecArray | null

    while ((match = fileBlockRegex.exec(content)) !== null) {
      const filename = match[1].trim()
      const fileContent = match[2].trim()
      const toolId = randomUUID()
      const preview =
        fileContent.length > 400
          ? `${fileContent.slice(0, 400)}\n…`
          : fileContent

      const absoluteHint = path.join(this.sandbox.outputPath, filename)
      this.emitTool(tools, onTool, {
        id: toolId,
        name: 'write_file',
        title: `写入 ${filename}`,
        status: 'waiting_approval',
        riskLevel: 'medium',
        input: {
          path: filename,
          absolutePath: absoluteHint,
          outputDir: this.sandbox.outputPath,
          bytes: Buffer.byteLength(fileContent, 'utf-8'),
          preview,
        },
      })

      try {
        const approved = await hitlCheckpoint(
          `写入文件：${filename}`,
          this.config.hitl,
          {
            type: 'file_write',
            riskLevel: 'medium',
            detail: { path: filename, preview },
          },
        )

        if (!approved) {
          this.finishTool(tools, onTool, toolId, 'cancelled', {
            name: 'write_file',
            title: `已取消写入 ${filename}`,
            output: { reason: '用户拒绝' },
          })
          continue
        }

        this.emitTool(tools, onTool, {
          id: toolId,
          name: 'write_file',
          title: `写入 ${filename}`,
          status: 'running',
          input: {
            path: filename,
            bytes: Buffer.byteLength(fileContent, 'utf-8'),
            preview,
          },
        })

        const writtenPath = this.sandbox.writeFile(filename, fileContent)
        filesWritten.push(filename)
        console.log(`[Agent] ✅ 已写入：${writtenPath}`)

        this.finishTool(tools, onTool, toolId, 'success', {
          name: 'write_file',
          title: `已写入 ${filename}`,
          output: { path: writtenPath },
        })
      } catch (error) {
        console.error(`[Agent] ❌ 写入失败 ${filename}:`, error)
        this.finishTool(tools, onTool, toolId, 'error', {
          name: 'write_file',
          title: `写入失败 ${filename}`,
          output: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    return filesWritten
  }

  async invoke(userMessage: string): Promise<AgentResult> {
    return this.invokeStream(userMessage, { writeToStdout: true })
  }

  /**
   * 流式调用。
   * - 终端模式：默认把 token 打到 stdout
   * - Web / SSE 模式：通过 onChunk / onTool 推送
   */
  async invokeStream(
    userMessage: string,
    options: StreamOptions = {},
  ): Promise<AgentResult> {
    const { onChunk, onStatus, onTool, writeToStdout = !onChunk } = options
    const tools: ToolCallEvent[] = []

    // 用户消息高风险检查
    if (isHighRiskOperation(userMessage, this.config.hitl.extraKeywords)) {
      const hitlId = randomUUID()
      this.emitTool(tools, onTool, {
        id: hitlId,
        name: 'hitl_check',
        title: '高风险指令确认',
        status: 'waiting_approval',
        riskLevel: 'high',
        input: { message: userMessage.slice(0, 200) },
      })

      const approved = await hitlCheckpoint(userMessage, this.config.hitl, {
        type: 'high_risk',
        riskLevel: 'high',
        detail: { message: userMessage },
      })

      if (!approved) {
        this.finishTool(tools, onTool, hitlId, 'cancelled', {
          name: 'hitl_check',
          title: '用户拒绝执行',
        })
        return {
          content: '操作已被用户取消。',
          message: this.conversationHistory,
          filesWritten: [],
          tools,
          cancelled: true,
        }
      }

      this.finishTool(tools, onTool, hitlId, 'success', {
        name: 'hitl_check',
        title: '用户已批准执行',
      })
    }

    this.conversationHistory.push({ role: 'user', content: userMessage })
    this.trimHistory()
    onStatus?.('thinking')
    console.log(
      `\n📨 [Agent] 收到任务：${userMessage.slice(0, 80)}${userMessage.length > 80 ? '...' : ''}`,
    )
    console.log('[Agent] 开始流式输出：\n')
    if (writeToStdout) console.log('─'.repeat(50))

    // Skill 扫描工具
    const skillScanId = randomUUID()
    this.emitTool(tools, onTool, {
      id: skillScanId,
      name: 'skill_scan',
      title: '扫描可用技能',
      status: 'running',
      input: { skillDir: this.config.skillDir, total: this.skills.length },
    })
    const matched = this.matchSkills(userMessage)
    this.finishTool(tools, onTool, skillScanId, 'success', {
      name: 'skill_scan',
      title:
        matched.length > 0
          ? `匹配到 ${matched.length} 个技能`
          : '未强匹配技能（将通用推理）',
      output: {
        matched: matched.map((s) => s.name),
        available: this.skills.map((s) => s.name),
      },
    })

    // LLM 生成
    // 天气属于时效性信息，命中意图后先查询真实数据，再交给模型组织回答。
    let externalContext = ''
    const weatherLocation = extractWeatherLocation(userMessage)
    if (weatherLocation) {
      const weatherToolId = randomUUID()
      this.emitTool(tools, onTool, {
        id: weatherToolId,
        name: 'weather_lookup',
        title: `查询 ${weatherLocation} 天气`,
        status: 'running',
        input: { location: weatherLocation, provider: 'Open-Meteo' },
      })
      try {
        const weather = await this.weather.getWeather(weatherLocation)
        externalContext = JSON.stringify(weather)
        this.finishTool(tools, onTool, weatherToolId, 'success', {
          name: 'weather_lookup',
          title: `${weather.location} 天气查询完成`,
          output: weather,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        externalContext = `天气工具调用失败：${message}。请明确告知用户暂时无法获取实时天气。`
        this.finishTool(tools, onTool, weatherToolId, 'error', {
          name: 'weather_lookup',
          title: `${weatherLocation} 天气查询失败`,
          output: { error: message },
        })
      }
    }

    const genId = randomUUID()
    this.emitTool(tools, onTool, {
      id: genId,
      name: 'llm_generate',
      title: `调用 ${this.config.model}`,
      status: 'running',
      input: {
        model: this.config.model,
        maxTokens: this.config.maxToken,
        historyTurns: this.conversationHistory.length,
      },
    })

    let fullContent = ''
    try {
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        max_tokens: this.config.maxToken,
        temperature: this.config.temperature,
        stream: true,
        messages: [
          { role: 'system', content: this.buildSystemPrompt(externalContext) },
          ...this.conversationHistory,
        ],
      })

      onStatus?.('streaming')
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? ''
        if (delta) {
          if (writeToStdout) process.stdout.write(delta)
          onChunk?.(delta)
          fullContent += delta
        }
      }

      this.finishTool(tools, onTool, genId, 'success', {
        name: 'llm_generate',
        title: `生成完成（${fullContent.length} 字符）`,
        output: { chars: fullContent.length },
      })
    } catch (error) {
      this.finishTool(tools, onTool, genId, 'error', {
        name: 'llm_generate',
        title: '模型调用失败',
        output: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }

    if (writeToStdout) console.log('\n' + '─'.repeat(50))
    this.conversationHistory.push({ role: 'assistant', content: fullContent })
    this.trimHistory()

    onStatus?.('writing_files')
    const filesWritten = await this.processFileOperations(
      fullContent,
      tools,
      onTool,
    )

    console.log('\n✅ [Agent] 流式执行完成')
    if (filesWritten.length > 0) {
      console.log(`📄 写入文件：${filesWritten.join(', ')}`)
    }
    onStatus?.('done')

    return {
      content: fullContent,
      message: this.conversationHistory,
      filesWritten,
      tools,
    }
  }

  writeFile(filename: string, content: string): string {
    if (!this.sandbox) throw new Error('沙箱未初始化')
    return this.sandbox.writeFile(filename, content)
  }

  getSandbox(): SandboxContent | null {
    return this.sandbox
  }

  /** 切换输出目录（支持使用者配置的任意本机绝对路径） */
  setOutputPath(outputPath: string, verbose = true): SandboxContent {
    this.config.sandbox = {
      ...this.config.sandbox,
      outputPath,
      verbose,
    }
    this.sandbox = createSandBox(this.config.sandbox)
    return this.sandbox
  }

  getOutputPath(): string {
    return this.sandbox?.outputPath ?? path.resolve(process.cwd(), 'output')
  }

  clearHistory(): void {
    this.conversationHistory = []
    console.log('[Agent] 对话历史已清空')
  }

  getHistory(): AgentMessage[] {
    return [...this.conversationHistory]
  }

  setHistory(history: AgentMessage[]): void {
    this.conversationHistory = [...history]
    this.trimHistory()
  }

  getSkills(): Skill[] {
    return this.skills
  }

  getModel(): string {
    return this.config.model
  }
}

/** 工厂函数：创建并初始化智能体。 */
export async function createAgent(config: AgentConfig): Promise<DeepAgent> {
  const agent = new DeepAgent(config)
  await agent.init()
  return agent
}

/** @deprecated 使用 createAgent；保留别名避免旧脚本立刻挂掉 */
export const creatAgent = createAgent

// re-export for convenience
export type { HitlConfig, HitlRequestMeta }
