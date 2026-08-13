import OpenAI from 'openai'
import { BaseEmbedding } from 'llamaindex'

export interface OpenAICompatibleEmbeddingConfig {
  apiKey: string
  baseURL: string
  model: string
  dimensions?: number
  timeoutMs?: number
  batchSize?: number
}

/**
 * 使用项目现有 OpenAI SDK 对接 embedding，兼容 OpenAI 风格的第三方端点。
 * 不依赖已废弃的 @llamaindex/openai provider，减少一层版本耦合。
 */
export class OpenAICompatibleEmbedding extends BaseEmbedding {
  private readonly client: OpenAI
  private readonly model: string
  private readonly dimensions?: number

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    super()
    this.model = config.model
    this.dimensions = config.dimensions
    this.embedBatchSize = config.batchSize ?? 64
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeoutMs ?? 60_000,
      maxRetries: 2,
    })
  }

  async getTextEmbedding(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text])
    return embedding ?? []
  }

  getTextEmbeddings = async (texts: string[]): Promise<number[][]> => {
    if (!texts.length) return []
    return this.embed(texts)
  }

  private async embed(input: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input,
      encoding_format: 'float',
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    })
    // OpenAI-compatible 服务不一定保证数组顺序，按 index 排序后再交给 LlamaIndex。
    return [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding)
  }
}

