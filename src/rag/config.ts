import path from 'path'

/** 将环境变量解析为布尔值，空值保持默认行为。 */
function truthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export interface RagConfig {
  enabled: boolean
  embeddingApiKey: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingDimensions?: number
  topK: number
  chunkSize: number
  chunkOverlap: number
  maxFileBytes: number
  maxTotalBytes: number
  maxFiles: number
  refreshIntervalMs: number
  cacheRoot: string
  extensions: Set<string>
  ignoredDirectories: Set<string>
  ignoredFiles: Set<string>
}

/**
 * RAG 使用独立的 embedding 配置，不复用 DeepSeek Key。
 * 这样即使知识库没有配置成功，也不会影响原有聊天链路。
 */
export function loadRagConfig(): RagConfig {
  const embeddingApiKey = (
    process.env.RAG_EMBEDDING_API_KEY ??
    process.env.OPENAI_API_KEY ??
    ''
  ).trim()
  const dimensions = Number(process.env.RAG_EMBEDDING_DIMENSIONS)
  const chunkSize = positiveInt(process.env.RAG_CHUNK_SIZE, 700)
  const configuredOverlap = positiveInt(process.env.RAG_CHUNK_OVERLAP, 100)

  return {
    enabled: truthy(process.env.RAG_ENABLED) && Boolean(embeddingApiKey),
    embeddingApiKey,
    embeddingBaseUrl: (
      process.env.RAG_EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1'
    ).replace(/\/$/, ''),
    embeddingModel:
      process.env.RAG_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
    embeddingDimensions:
      Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : undefined,
    topK: positiveInt(process.env.RAG_TOP_K, 5),
    chunkSize,
    chunkOverlap: Math.min(configuredOverlap, Math.max(1, chunkSize - 1)),
    maxFileBytes: positiveInt(process.env.RAG_MAX_FILE_BYTES, 2 * 1024 * 1024),
    maxTotalBytes: positiveInt(process.env.RAG_MAX_TOTAL_BYTES, 50 * 1024 * 1024),
    maxFiles: positiveInt(process.env.RAG_MAX_FILES, 2_000),
    refreshIntervalMs: positiveInt(process.env.RAG_REFRESH_INTERVAL_MS, 30_000),
    cacheRoot: path.resolve(
      process.cwd(),
      process.env.RAG_CACHE_DIR?.trim() || '.deepcodex/rag',
    ),
    extensions: new Set(
      (
        process.env.RAG_EXTENSIONS ||
        '.md,.mdx,.txt,.json,.jsonl,.csv,.tsv,.html,.css,.js,.jsx,.ts,.tsx,.vue,.py,.java,.go,.rs,.sql,.yaml,.yml,.toml,.xml'
      )
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => (item.startsWith('.') ? item : `.${item}`)),
    ),
    ignoredDirectories: new Set(
      (process.env.RAG_IGNORE_DIRS || '.git,node_modules,dist,.deepcodex,.next,coverage')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
    ignoredFiles: new Set(
      (process.env.RAG_IGNORE_FILES || 'package-lock.json,pnpm-lock.yaml,yarn.lock')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  }
}
