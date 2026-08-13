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
import { type Skill, loadSkills, SkillRegistry } from './skill-loader.js'
import type { ToolCallEvent, ToolStatus } from './sessions.js'
import { ToolRegistry } from './tool-registry.js'
import { createWeatherTool } from './tools/weather-tool.js'

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
   * 预加载的 Skill 列表（服务端复用，跳过文件系统扫描）。
   * 若提供则 init() 不会再次调用 loadSkills()。
   */
  skills?: Skill[]
  /**
   * 预构建的 Skill 注册表，与 skills 配套使用。
   */
  skillRegistry?: SkillRegistry
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
  /** 客户端断开或任务超时时，统一终止模型和工具调用。 */
  signal?: AbortSignal
  userId?: string
  sessionId?: string
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

export class deepCodex {
  private client: OpenAI
  private config: ResolvedAgentConfig
  private skills: Skill[] = []
  private skillRegistry = new SkillRegistry([])
  private toolRegistry: ToolRegistry
  private sandbox: SandboxContent | null = null
  private conversationHistory: AgentMessage[] = []

  constructor(config: AgentConfig) {
    this.config = {
      name: config.name,
      // DeepSeek 已停用旧模型别名，默认使用新的通用对话模型名称。
      model: config.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '',
      temperature:
        config.temperature ?? Number(process.env.DEEPSEEK_TEMPERATURE ?? 0.7),
      skillDir: config.skillDir ?? '.deepcodex/skills',
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
    // 支持预加载 Skill（服务端复用），跳过 init() 中的文件系统扫描。
    if (config.skills?.length) {
      this.skills = config.skills
      this.skillRegistry = config.skillRegistry ?? new SkillRegistry(config.skills)
    }
    this.toolRegistry = new ToolRegistry({
      defaultTimeoutMs: Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15_000),
      maxToolsPerTurn: Number(process.env.AGENT_MAX_TOOLS_PER_TURN ?? 3),
    })
    this.toolRegistry.register(createWeatherTool())

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

    if (this.skills.length > 0) {
      console.log(`[Agent] 使用预加载 Skill（${this.skills.length} 个），跳过文件系统扫描`)
    } else {
      console.log('\n📂 [Agent] 正在加载 Skill 文件...')
      this.skills = loadSkills(this.config.skillDir)
      this.skillRegistry = new SkillRegistry(this.skills)
    }
    console.log(`[Agent] 共加载 ${this.skills.length} 个 Skill`)

    console.log('\n🔒 [Agent] 正在初始化沙箱...')
    this.sandbox = createSandBox(this.config.sandbox)

    // 条件注册 Tavily 搜索工具
    if (process.env.TAVILY_API_KEY) {
      try {
        const { createTavilySearchTool } = await import('./tools/tavily-tool.js')
        this.toolRegistry.register(createTavilySearchTool())
        console.log('[Agent] Tavily 搜索工具已注册')
      } catch (err) {
        console.warn('[Agent] Tavily 工具注册失败（将跳过）:', err)
      }
    }

    // RAG 配置完整时才注册，未配置 embedding 不影响原有 Agent 启动。
    if (/^(1|true|yes|on)$/i.test(process.env.RAG_ENABLED ?? '')) {
      try {
        const { loadRagConfig } = await import('./rag/config.js')
        const { createWorkspaceRagTool } = await import(
          './tools/workspace-rag-tool.js'
        )
        const ragConfig = loadRagConfig()
        if (ragConfig.enabled) {
          this.toolRegistry.register(
            createWorkspaceRagTool(
              () => this.sandbox?.outputPath ?? this.config.sandbox.outputPath ?? '',
            ),
          )
          console.log('[Agent] 工作区 RAG 检索工具已注册')
        } else {
          console.warn('[Agent] RAG_ENABLED 已开启，但缺少 RAG_EMBEDDING_API_KEY')
        }
      } catch (err) {
        console.warn('[Agent] 工作区 RAG 工具注册失败（将跳过）:', err)
      }
    }

    console.log(`\n✅ [Agent] 初始化完成，模型：${this.config.model}`)
    console.log(`${'='.repeat(50)}\n`)
  }

  private buildSystemPrompt(
    externalContext = '',
    matchedSkills: Skill[] = [],
  ): string {
    const skillsSection = this.skillRegistry.buildOverviewPrompt()
    const executionSection =
      this.skillRegistry.buildExecutionPrompt(matchedSkills)
    const sandboxSection = this.sandbox
      ? `\n## 工作区信息\n当前输出目录（绝对路径）：${this.sandbox.outputPath}\n所有通过 filename 代码块写出的文件都会写入此目录（可含子目录）。\n用户若提到「写到桌面 / 某文件夹」，你只需用相对文件名写出即可，系统会落到当前输出目录。`
      : ''

    return `你是 ${this.config.name}，一个基于 DeepSeek 的通用型 AI 智能体。

## 核心能力
- 理解用户的自然语言目标，自动规划执行步骤
- 调用相应的 Skill 技能处理专项任务
- 将结果写入本地文件系统
${skillsSection}
${executionSection}
${sandboxSection}

## 行为准则
- 每次回复说明你正在做什么（Planning → 执行 → 输出）
- **当系统提示中包含 Script 或"必须执行的步骤"时，你必须严格按照步骤顺序逐条执行，不得跳过或自由发挥**
- 执行 Skill 步骤时在回复中明确标注当前步骤（如"正在执行第1步"）
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

  /** 滑动窗口：超出阈值时用 LLM 压缩早期对话为摘要，保留最近消息。 */
  private async compactHistory(): Promise<void> {
    const max = this.config.maxHistoryMessages
    if (this.conversationHistory.length <= max) return

    // 保留最近 max/2 条消息，将更早的消息压缩为摘要
    const recentCount = Math.floor(max / 2)
    const toSummarize = this.conversationHistory.slice(0, -recentCount)
    const recent = this.conversationHistory.slice(-recentCount)

    const conversationText = toSummarize
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 2000)}`)
      .join('\n\n')

    try {
      const summaryResponse = await this.client.chat.completions.create({
        model: this.config.model,
        max_tokens: 800,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: '你是对话摘要助手。用中文将以下对话压缩为一段简洁摘要（不超过300字），保留关键事实、决策和用户目标。',
          },
          { role: 'user', content: `请总结以下对话：\n\n${conversationText}` },
        ],
      })

      const summaryText = summaryResponse.choices[0]?.message?.content?.trim() ?? ''
      const dropped = toSummarize.length

      this.conversationHistory = [
        { role: 'assistant', content: `[对话摘要] ${summaryText}` },
        ...recent,
      ]

      console.log(
        `[Agent] 历史已压缩：丢弃 ${dropped} 条 → 生成 ${summaryText.length} 字摘要，保留最近 ${recent.length} 条`,
      )
    } catch (error) {
      // 摘要失败时回退到简单截断
      console.warn('[Agent] 摘要生成失败，回退到简单截断:', error)
      const trimmed = this.conversationHistory.slice(-max)
      if (trimmed.length > 0 && trimmed[0].role === 'assistant') {
        trimmed.shift()
      }
      this.conversationHistory = trimmed
    }
  }

  /** 调用被取消或失败时撤销本轮 user 消息，避免留下不成对的上下文。 */
  private rollbackPendingUserMessage(userMessage: string): void {
    const last = this.conversationHistory.at(-1)
    if (last?.role === 'user' && last.content === userMessage) {
      this.conversationHistory.pop()
    }
  }

  /** 粗粒度匹配可能触发的 Skill，用于工具时间线展示 */
  private matchSkills(userMessage: string): Skill[] {
    return this.skillRegistry.match(userMessage)
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
    const {
      onChunk,
      onStatus,
      onTool,
      writeToStdout = !onChunk,
      signal = new AbortController().signal,
      userId,
      sessionId,
    } = options
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
    await this.compactHistory()
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

    // 统一工具调度：后续新增搜索、数据库等工具时无需修改 Agent 主流程。
    const externalContexts: string[] = []
    const matchedTools = this.toolRegistry.match(userMessage)
    for (const { tool, input } of matchedTools) {
      if (signal.aborted) throw signal.reason
      const toolId = randomUUID()
      this.emitTool(tools, onTool, {
        id: toolId,
        name: tool.name,
        title: `执行工具：${tool.description}`,
        status: 'running',
        riskLevel: tool.riskLevel,
        input,
      })
      try {
        const executed = await this.toolRegistry.execute(tool, input, {
          signal,
          userId,
          sessionId,
        })
        externalContexts.push(`### ${tool.name}\n${executed.prompt}`)
        this.finishTool(tools, onTool, toolId, 'success', {
          name: tool.name,
          title: `${tool.description}完成`,
          output: executed.output,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const cancelled =
          signal.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        externalContexts.push(
          `### ${tool.name}\n工具调用失败：${message}。请明确告知用户。`,
        )
        this.finishTool(tools, onTool, toolId, cancelled ? 'cancelled' : 'error', {
          name: tool.name,
          title: `${tool.description}${cancelled ? '已取消' : '失败'}`,
          output: { error: message },
        })
        if (cancelled) {
          this.rollbackPendingUserMessage(userMessage)
          throw error
        }
      }
    }
    const externalContext = externalContexts.join('\n\n')

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
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          max_tokens: this.config.maxToken,
          temperature: this.config.temperature,
          stream: true,
          messages: [
            {
              role: 'system',
              content: this.buildSystemPrompt(externalContext, matched),
            },
            ...this.conversationHistory,
          ],
        },
        { signal },
      )

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
      this.rollbackPendingUserMessage(userMessage)
      const cancelled = signal.aborted
      this.finishTool(tools, onTool, genId, cancelled ? 'cancelled' : 'error', {
        name: 'llm_generate',
        title: cancelled ? '模型调用已取消' : '模型调用失败',
        output: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }

    if (writeToStdout) console.log('\n' + '─'.repeat(50))
    this.conversationHistory.push({ role: 'assistant', content: fullContent })
    await this.compactHistory()

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
    if (this.conversationHistory.length > this.config.maxHistoryMessages) {
      console.warn(
        `[Agent] setHistory: 历史消息 ${this.conversationHistory.length} 超出阈值 ${this.config.maxHistoryMessages}，将在下次调用时压缩`,
      )
    }
  }

  getSkills(): Skill[] {
    return this.skills
  }

  getModel(): string {
    return this.config.model
  }
}

/** 工厂函数：创建并初始化智能体。 */
export async function createAgent(config: AgentConfig): Promise<deepCodex> {
  const agent = new deepCodex(config)
  await agent.init()
  return agent
}

/** @deprecated 请使用 createAgent；此别名将在 v2.0 中移除 */
export const creatAgent: typeof createAgent = createAgent

// re-export for convenience
export type { HitlConfig, HitlRequestMeta }
export type { Skill } from './skill-loader.js'
export { SkillRegistry } from './skill-loader.js'
