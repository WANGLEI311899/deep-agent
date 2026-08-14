import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import {
  Document,
  MetadataMode,
  SentenceSplitter,
  Settings,
  VectorStoreIndex,
  storageContextFromDefaults,
  type NodeWithScore,
} from 'llamaindex'
import { loadRagConfig, type RagConfig } from './config.js'
import {
  EmbeddingProviderChangedError,
  OpenAICompatibleEmbedding,
} from './openai-compatible-embedding.js'
import {
  analyzeMedia,
  validateMediaUpload,
} from '../multimodal/media-service.js'

interface IndexedFile {
  relativePath: string
  absolutePath: string
  size: number
  modifiedAt: number
}

interface RagManifest {
  version: 2
  workspacePath: string
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  /** 内容解析管线变化时强制重建，避免复用旧的纯文本索引。 */
  contentPipeline: string
  generatedAt: string
  files: Array<Pick<IndexedFile, 'relativePath' | 'size' | 'modifiedAt'>>
}

export interface RagSource {
  path: string
  score: number
  content: string
  startChar?: number
  endChar?: number
}

export interface RagQueryResult {
  query: string
  workspacePath: string
  indexedFiles: number
  sources: RagSource[]
  refreshed: boolean
}

export interface RagStatus {
  enabled: boolean
  workspacePath: string
  indexedFiles: number
  ready: boolean
  reason?: string
}

function workspaceKey(workspacePath: string): string {
  return createHash('sha256').update(workspacePath.toLowerCase()).digest('hex').slice(0, 20)
}

function normalizedManifestFiles(files: IndexedFile[]): RagManifest['files'] {
  return files.map(({ relativePath, size, modifiedAt }) => ({
    relativePath: relativePath.replace(/\\/g, '/'),
    size,
    modifiedAt: Math.trunc(modifiedAt),
  }))
}

function sameFiles(
  left: RagManifest['files'] | undefined,
  right: RagManifest['files'],
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right)
}

/**
 * 管理一个工作区的持久化向量索引。
 * 查询前只比较文件清单；内容未变化时直接复用内存或磁盘索引。
 */
export class WorkspaceRagService {
  private readonly config: RagConfig
  private readonly workspacePath: string
  private readonly cacheDir: string
  private readonly persistDir: string
  private readonly manifestPath: string
  private readonly embedding: OpenAICompatibleEmbedding | null
  private index: VectorStoreIndex | null = null
  private manifest: RagManifest | null = null
  private lastCheckedAt = 0
  private syncPromise: Promise<boolean> | null = null

  constructor(workspacePath: string, config = loadRagConfig()) {
    this.config = config
    this.workspacePath = path.resolve(workspacePath)
    this.cacheDir = path.join(config.cacheRoot, workspaceKey(this.workspacePath))
    this.persistDir = path.join(this.cacheDir, 'storage')
    this.manifestPath = path.join(this.cacheDir, 'manifest.json')
    // 禁用状态仍允许执行 rag:status，因此不要提前构造会校验 Key 的 SDK 客户端。
    this.embedding = config.enabled
      ? new OpenAICompatibleEmbedding({
          apiKey: config.embeddingApiKey,
          baseURL: config.embeddingBaseUrl,
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions,
          fallback: config.embeddingFallbackEnabled
            ? {
                name: 'Ollama',
                apiKey: 'ollama',
                baseURL: config.embeddingFallbackBaseUrl,
                model: config.embeddingFallbackModel,
              }
            : undefined,
        })
      : null
  }

  async status(): Promise<RagStatus> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        workspacePath: this.workspacePath,
        indexedFiles: 0,
        ready: false,
        reason: '请配置 RAG_ENABLED=true 和 RAG_EMBEDDING_API_KEY。',
      }
    }
    await this.loadManifest()
    return {
      enabled: true,
      workspacePath: this.workspacePath,
      indexedFiles: this.manifest?.files.length ?? 0,
      ready: Boolean(this.index || this.manifest),
    }
  }

  async query(query: string, topK = this.config.topK): Promise<RagQueryResult> {
    if (!this.config.enabled) {
      throw new Error('工作区知识库未启用：请配置 RAG_ENABLED=true 和 embedding 参数。')
    }
    const refreshed = await this.ensureIndex()
    if (!this.index || !this.manifest) {
      throw new Error('工作区没有可索引的文本文件。')
    }

    let nodes: NodeWithScore[]
    try {
      nodes = await this.withEmbedding(() => this.index!.asRetriever({ similarityTopK: Math.max(1, topK) }).retrieve(query))
    } catch (error) {
      if (!(error instanceof EmbeddingProviderChangedError)) throw error
      // 查询期间主服务失效时，使用新供应商完整重建后再重试一次。
      await this.build(await this.collectFiles())
      nodes = await this.withEmbedding(() => this.index!.asRetriever({ similarityTopK: Math.max(1, topK) }).retrieve(query))
    }
    return {
      query,
      workspacePath: this.workspacePath,
      indexedFiles: this.manifest.files.length,
      sources: nodes.map((item) => this.toSource(item)),
      refreshed,
    }
  }

  /** 强制重新扫描并构建索引，供 CLI 或管理接口使用。 */
  async rebuild(): Promise<number> {
    if (!this.config.enabled) {
      throw new Error('工作区知识库未启用。')
    }
    const files = await this.collectFiles()
    await this.build(files)
    return files.length
  }

  private async ensureIndex(): Promise<boolean> {
    if (this.syncPromise) return this.syncPromise
    this.syncPromise = this.syncIndex().finally(() => {
      this.syncPromise = null
    })
    return this.syncPromise
  }

  private async syncIndex(): Promise<boolean> {
    const now = Date.now()
    if (this.index && now - this.lastCheckedAt < this.config.refreshIntervalMs) {
      return false
    }
    this.lastCheckedAt = now
    const files = await this.collectFiles()
    const nextFiles = normalizedManifestFiles(files)
    await this.embedding?.ensureProvider()
    await this.loadManifest()

    const compatible =
      this.manifest?.version === 2 &&
      this.manifest?.embeddingModel === this.config.embeddingModel &&
      this.manifest.chunkSize === this.config.chunkSize &&
      this.manifest.chunkOverlap === this.config.chunkOverlap &&
      this.manifest.contentPipeline === this.contentPipeline() &&
      sameFiles(this.manifest.files, nextFiles)

    if (compatible) {
      if (!this.index) await this.loadPersistedIndex()
      return false
    }
    await this.build(files)
    return true
  }

  private async build(files: IndexedFile[], providerRetry = 1): Promise<void> {
    if (!files.length) {
      this.index = null
      this.manifest = null
      return
    }
    const candidates = await Promise.all(
      files.map(async (file) => {
        let text: string
        try {
          text = await this.readIndexText(file)
        } catch (error) {
          // 单个媒体文件解析失败不应阻断整个工作区索引；状态会在控制台明确可见。
          console.warn(`[RAG] 跳过无法解析的文件 ${file.relativePath}:`, error)
          return null
        }
        return new Document({
          id_: file.relativePath.replace(/\\/g, '/'),
          text,
          metadata: {
            sourcePath: file.relativePath.replace(/\\/g, '/'),
            absolutePath: file.absolutePath,
            modifiedAt: file.modifiedAt,
          },
          // 路径用于引用，但绝对路径不参与 embedding，避免污染语义向量。
          excludedEmbedMetadataKeys: ['absolutePath', 'modifiedAt'],
          excludedLlmMetadataKeys: ['absolutePath', 'modifiedAt'],
        })
      }),
    )
    const documents = candidates.filter((item) => item !== null)

    if (!documents.length) {
      this.index = null
      this.manifest = null
      return
    }

    await this.resetPersistDir()
    // storageContext 初始化本身也会读取 Settings.embedModel，因此必须放在同一作用域内。
    try {
      this.index = await this.withEmbedding(async () => {
        const storageContext = await storageContextFromDefaults({ persistDir: this.persistDir })
        const nodeParser = new SentenceSplitter({ chunkSize: this.config.chunkSize, chunkOverlap: this.config.chunkOverlap })
        return Settings.withNodeParser(nodeParser, () => VectorStoreIndex.fromDocuments(documents, { storageContext, logProgress: false }))
      })
    } catch (error) {
      if (error instanceof EmbeddingProviderChangedError && providerRetry > 0) {
        await this.build(files, providerRetry - 1)
        return
      }
      throw error
    }
    this.manifest = {
      version: 2,
      workspacePath: this.workspacePath,
      embeddingModel: this.config.embeddingModel,
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      contentPipeline: this.contentPipeline(),
      generatedAt: new Date().toISOString(),
      files: normalizedManifestFiles(files),
    }
    await fs.mkdir(this.cacheDir, { recursive: true })
    await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8')
  }

  private contentPipeline(): string {
    const embedding = this.embedding?.providerSignature() ?? this.config.embeddingModel
    if (!this.config.multimodalEnabled) return `text-v2:${embedding}`
    return `multimodal-v2:${embedding}:${process.env.VISION_MODEL ?? 'gpt-4.1-mini'}:${process.env.OLLAMA_VISION_MODEL ?? 'qwen3-vl:8b'}`
  }

  /** 将 PDF/图片先转换为可检索 Markdown，其余文件保持原有 UTF-8 文本读取。 */
  private async readIndexText(file: IndexedFile): Promise<string> {
    const extension = path.extname(file.absolutePath).toLowerCase()
    const mediaMime: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    }
    const mimeType = mediaMime[extension]
    if (!mimeType) return fs.readFile(file.absolutePath, 'utf8')
    if (!this.config.multimodalEnabled) {
      throw new Error('媒体 RAG 未启用，请配置 RAG_MULTIMODAL_ENABLED=true。')
    }
    const buffer = await fs.readFile(file.absolutePath)
    const upload = validateMediaUpload(file.relativePath, mimeType, buffer)
    const result = await analyzeMedia(upload, {
      instruction: '为知识库检索提取完整内容。保留标题层级、表格、页码、图表含义和关键视觉信息。',
    })
    return `# ${file.relativePath}\n\n${result.analysis}`
  }

  private async loadPersistedIndex(): Promise<void> {
    this.index = await this.withEmbedding(async () => {
      const storageContext = await storageContextFromDefaults({
        persistDir: this.persistDir,
      })
      return VectorStoreIndex.init({ storageContext })
    })
  }

  private async loadManifest(): Promise<void> {
    if (this.manifest) return
    try {
      this.manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) as RagManifest
    } catch {
      this.manifest = null
    }
  }

  private withEmbedding<T>(action: () => T): T {
    if (!this.embedding) throw new Error('工作区知识库未配置 embedding。')
    return Settings.withEmbedModel(this.embedding, action)
  }

  private toSource(item: NodeWithScore): RagSource {
    const metadata = item.node.metadata as Record<string, unknown>
    return {
      path: String(metadata.sourcePath ?? item.node.id_),
      score: item.score ?? 0,
      content: item.node.getContent(MetadataMode.NONE),
      startChar:
        typeof metadata.startCharIdx === 'number' ? metadata.startCharIdx : undefined,
      endChar:
        typeof metadata.endCharIdx === 'number' ? metadata.endCharIdx : undefined,
    }
  }

  private async collectFiles(): Promise<IndexedFile[]> {
    const output: IndexedFile[] = []
    let totalBytes = 0
    const visit = async (directory: string): Promise<void> => {
      if (output.length >= this.config.maxFiles) return
      const entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (output.length >= this.config.maxFiles) break
        const absolutePath = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!this.config.ignoredDirectories.has(entry.name.toLowerCase())) {
            await visit(absolutePath)
          }
          continue
        }
        if (
          !entry.isFile() ||
          this.config.ignoredFiles.has(entry.name.toLowerCase()) ||
          !this.config.extensions.has(path.extname(entry.name).toLowerCase())
        ) {
          continue
        }
        const stat = await fs.stat(absolutePath)
        if (stat.size === 0 || stat.size > this.config.maxFileBytes) continue
        // 总量上限避免误选大型源码目录后产生不可控的 embedding 成本。
        if (totalBytes + stat.size > this.config.maxTotalBytes) continue
        totalBytes += stat.size
        output.push({
          relativePath: path.relative(this.workspacePath, absolutePath),
          absolutePath,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        })
      }
    }
    await visit(this.workspacePath)
    return output
  }

  private async resetPersistDir(): Promise<void> {
    const resolved = path.resolve(this.persistDir)
    const root = `${path.resolve(this.config.cacheRoot)}${path.sep}`
    if (!resolved.startsWith(root)) {
      throw new Error('拒绝清理 RAG 缓存目录之外的路径。')
    }
    await fs.rm(resolved, { recursive: true, force: true })
    await fs.mkdir(resolved, { recursive: true })
  }
}

const serviceCache = new Map<string, WorkspaceRagService>()

/** 同一进程内按工作区复用索引实例，避免每个会话重复加载向量文件。 */
export function getWorkspaceRagService(workspacePath: string): WorkspaceRagService {
  const resolved = path.resolve(workspacePath)
  let service = serviceCache.get(resolved)
  if (!service) {
    service = new WorkspaceRagService(resolved)
    serviceCache.set(resolved, service)
  }
  return service
}
