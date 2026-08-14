import OpenAI from 'openai'
import { BaseEmbedding } from 'llamaindex'
import { getProviderCircuitBreaker } from '../providers/circuit-breaker.js'

export interface EmbeddingEndpointConfig {
  name: string
  apiKey: string
  baseURL: string
  model: string
  dimensions?: number
}

export interface OpenAICompatibleEmbeddingConfig extends Omit<EmbeddingEndpointConfig, 'name'> {
  timeoutMs?: number
  batchSize?: number
  fallback?: EmbeddingEndpointConfig
}

/** 提醒索引层：向量模型已切换，必须从头重建，不能混合不同维度的向量。 */
export class EmbeddingProviderChangedError extends Error {
  constructor(public readonly providerSignature: string) {
    super(`Embedding 服务已切换为 ${providerSignature}，需要重建索引。`)
    this.name = 'EmbeddingProviderChangedError'
  }
}

interface Endpoint extends EmbeddingEndpointConfig { client: OpenAI }

/**
 * OpenAI-compatible embedding，启动时探测主服务；额度不足时自动切到 Ollama。
 * 一旦切换会通知索引层完整重建，避免不同模型的向量维度或语义空间混用。
 */
export class OpenAICompatibleEmbedding extends BaseEmbedding {
  private readonly endpoints: Endpoint[]
  private activeIndex = -1

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    super()
    this.embedBatchSize = config.batchSize ?? 64
    const raw: EmbeddingEndpointConfig[] = [{ name: 'OpenAI', apiKey: config.apiKey, baseURL: config.baseURL, model: config.model, dimensions: config.dimensions }]
    if (config.fallback) raw.push(config.fallback)
    this.endpoints = raw.filter((item) => Boolean(item.apiKey)).map((item) => ({
      ...item,
      baseURL: item.baseURL.replace(/\/$/, ''),
      client: new OpenAI({ apiKey: item.apiKey, baseURL: item.baseURL, timeout: config.timeoutMs ?? 60_000, maxRetries: 0 }),
    }))
  }

  async ensureProvider(): Promise<string> {
    if (this.activeIndex >= 0) return this.providerSignature()
    const errors: string[] = []
    for (let index = 0; index < this.endpoints.length; index += 1) {
      const endpoint = this.endpoints[index]
      const breaker = getProviderCircuitBreaker(`embedding:${endpoint.baseURL}:${endpoint.model}`)
      if (!breaker.canAttempt()) continue
      try {
        await this.request(endpoint, ['provider health check'])
        breaker.recordSuccess()
        this.activeIndex = index
        return this.providerSignature()
      } catch (error) {
        breaker.recordFailure(error)
        errors.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`没有可用的 Embedding 服务。${errors.join('；')}`)
  }

  providerSignature(): string {
    const endpoint = this.endpoints[this.activeIndex]
    return endpoint ? `${endpoint.name}:${endpoint.baseURL}:${endpoint.model}` : 'unselected'
  }

  async getTextEmbedding(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text])
    return embedding ?? []
  }

  getTextEmbeddings = async (texts: string[]): Promise<number[][]> => texts.length ? this.embed(texts) : []

  private async embed(input: string[]): Promise<number[][]> {
    await this.ensureProvider()
    const endpoint = this.endpoints[this.activeIndex]
    try {
      return await this.request(endpoint, input)
    } catch (error) {
      getProviderCircuitBreaker(`embedding:${endpoint.baseURL}:${endpoint.model}`).recordFailure(error)
      if (this.activeIndex + 1 >= this.endpoints.length) throw error
      this.activeIndex = -1
      // 重新探测会跳过已熔断的 OpenAI，并选择 Ollama。
      await this.ensureProvider()
      throw new EmbeddingProviderChangedError(this.providerSignature())
    }
  }

  private async request(endpoint: Endpoint, input: string[]): Promise<number[][]> {
    const response = await endpoint.client.embeddings.create({
      model: endpoint.model,
      input,
      encoding_format: 'float',
      ...(endpoint.dimensions ? { dimensions: endpoint.dimensions } : {}),
    })
    return [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding)
  }
}
