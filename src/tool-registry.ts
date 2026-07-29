/**
 * Agent 工具注册中心。
 *
 * 工具负责声明触发条件、风险级别和执行逻辑；AgentRuntime 只负责调度，
 * 避免后续每增加一个工具都继续扩大 agent.ts。
 */
export type ToolRiskLevel = 'low' | 'medium' | 'high'

export interface ToolExecutionContext {
  /** 当前用户，用于工具内部继续做资源归属校验。 */
  userId?: string
  /** 当前会话，便于日志和审计关联。 */
  sessionId?: string
  /** 统一取消信号，客户端断开或任务超时时会触发。 */
  signal: AbortSignal
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  riskLevel: ToolRiskLevel
  /** 返回 null 表示本轮不需要调用该工具。 */
  match: (message: string) => TInput | null
  execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<TOutput>
  /** 单工具超时；未设置时使用注册中心默认值。 */
  timeoutMs?: number
  /** 将工具结果转换为可以安全注入模型的上下文。 */
  toPrompt?: (output: TOutput) => string
}

export interface ExecutedTool {
  tool: AgentTool<unknown, unknown>
  input: unknown
  output: unknown
  prompt: string
}

export interface ToolRegistryOptions {
  defaultTimeoutMs?: number
  maxToolsPerTurn?: number
}

function combineSignals(
  parent: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<unknown, unknown>>()
  private readonly defaultTimeoutMs: number
  private readonly maxToolsPerTurn: number

  constructor(options: ToolRegistryOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000
    this.maxToolsPerTurn = options.maxToolsPerTurn ?? 3
  }

  register<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具名称重复：${tool.name}`)
    }
    this.tools.set(tool.name, tool as AgentTool<unknown, unknown>)
  }

  list(): AgentTool<unknown, unknown>[] {
    return [...this.tools.values()]
  }

  match(message: string): Array<{
    tool: AgentTool<unknown, unknown>
    input: unknown
  }> {
    const matched: Array<{
      tool: AgentTool<unknown, unknown>
      input: unknown
    }> = []

    for (const tool of this.tools.values()) {
      const input = tool.match(message)
      if (input !== null) matched.push({ tool, input })
      if (matched.length >= this.maxToolsPerTurn) break
    }
    return matched
  }

  async execute(
    tool: AgentTool<unknown, unknown>,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ExecutedTool> {
    const signal = combineSignals(
      context.signal,
      tool.timeoutMs ?? this.defaultTimeoutMs,
    )
    const output = await tool.execute(input, { ...context, signal })
    return {
      tool,
      input,
      output,
      prompt: tool.toPrompt?.(output) ?? JSON.stringify(output),
    }
  }
}
