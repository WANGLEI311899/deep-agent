/**
 * 多模态附件解析服务。
 * 默认降级顺序：OpenAI 视觉 -> Ollama 本地视觉 -> 本地 OCR/PDF 文本提取。
 * 原始文件只在请求内存中处理，不会写入会话或工作区。
 */
import type http from 'http'
import path from 'path'
import Busboy from 'busboy'
import OpenAI from 'openai'
import { AppError, ErrorCodes } from '../errors.js'
import { getProviderCircuitBreaker } from '../providers/circuit-breaker.js'
import {
  OCR_UPLOAD_RULES,
  recognizeImage,
  validateImageUpload,
  type OcrUpload,
} from '../ocr/ocr-service.js'

export const MEDIA_UPLOAD_RULES = {
  maxFiles: 1,
  maxBytes: 20 * 1024 * 1024,
  maxAnalysisChars: 40_000,
  extensions: ['.jpg', '.jpeg', '.png', '.webp', '.pdf'],
  mimeTypes: [...OCR_UPLOAD_RULES.mimeTypes, 'application/pdf'],
} as const

export const MEDIA_UPLOAD_HINT =
  '支持 JPG/JPEG、PNG、WebP、PDF；每次只能上传 1 个文件；单个文件不超过 20 MB。'

export interface MediaUpload {
  filename: string
  mimeType: string
  buffer: Buffer
  kind: 'image' | 'pdf'
  width?: number
  height?: number
}

export interface VisionInput {
  filename: string
  mimeType: string
  buffer: Buffer
  instruction: string
  ocrText?: string
  signal?: AbortSignal
}

export interface VisionAnalysis {
  text: string
  provider: string
  model: string
}

export interface VisionAnalyzer {
  isConfigured(): boolean
  analyze(input: VisionInput): Promise<VisionAnalysis>
}

export interface MediaAnalysisResult {
  id?: string
  type: 'image' | 'pdf'
  filename: string
  mimeType: string
  analysis: string
  ocrText?: string
  confidence?: number
  mode: 'hybrid' | 'vision' | 'ocr' | 'local-pdf'
  provider?: string
  model?: string
  warning?: string
}

function truthy(value: string | undefined): boolean {
  return Boolean(value && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()))
}

function mediaError(message: string, status = 400): AppError {
  return new AppError(
    ErrorCodes.OcrInvalidImage,
    `${message} ${MEDIA_UPLOAD_HINT}`,
    status,
    'media_upload_validation',
  )
}

/** 校验扩展名、MIME 和魔数，阻止伪装上传。 */
export function validateMediaUpload(filename: string, declaredMime: string, buffer: Buffer): MediaUpload {
  const safeName = path.basename(filename || '未命名文件')
  const extension = path.extname(safeName).toLowerCase()
  if (!MEDIA_UPLOAD_RULES.extensions.includes(extension as never)) throw mediaError(`“${safeName}”的文件格式不正确。`)
  if (!MEDIA_UPLOAD_RULES.mimeTypes.includes(declaredMime as never)) throw mediaError(`“${safeName}”不是受支持的文件类型。`)
  if (!buffer.length) throw mediaError('上传的文件内容为空。')
  if (buffer.length > MEDIA_UPLOAD_RULES.maxBytes) throw mediaError('文件超过 20 MB。', 413)

  if (extension === '.pdf' || declaredMime === 'application/pdf') {
    if (extension !== '.pdf' || declaredMime !== 'application/pdf') throw mediaError('PDF 的扩展名与 MIME 类型不一致。')
    if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw mediaError('PDF 文件头无效，文件可能已损坏或被伪装。')
    return { filename: safeName, mimeType: 'application/pdf', buffer, kind: 'pdf' }
  }

  const image = validateImageUpload(safeName, declaredMime, buffer)
  return { ...image, kind: 'image' }
}

/** 使用带上限的 multipart 流读取单个图片或 PDF。 */
export function readMediaUpload(req: http.IncomingMessage): Promise<MediaUpload> {
  return new Promise((resolve, reject) => {
    let parser: Busboy.Busboy
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MEDIA_UPLOAD_RULES.maxBytes, fields: 0, parts: 2 } })
    } catch {
      reject(mediaError('请求必须使用 multipart/form-data 上传文件。'))
      return
    }
    let upload: Promise<MediaUpload> | null = null
    let tooMany = false
    parser.on('file', (_field, stream, info) => {
      if (upload) { stream.resume(); tooMany = true; return }
      const chunks: Buffer[] = []
      let truncated = false
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => { truncated = true })
      upload = new Promise((fileResolve, fileReject) => {
        stream.on('end', () => {
          if (truncated) { fileReject(mediaError('文件超过 20 MB。', 413)); return }
          try { fileResolve(validateMediaUpload(info.filename, info.mimeType, Buffer.concat(chunks))) } catch (error) { fileReject(error) }
        })
        stream.on('error', fileReject)
      })
      void upload.catch(() => undefined)
    })
    parser.on('filesLimit', () => { tooMany = true })
    parser.on('error', reject)
    parser.on('finish', async () => {
      try {
        if (tooMany) throw mediaError('一次只能上传 1 个文件。')
        if (!upload) throw mediaError('没有找到上传文件。')
        resolve(await upload)
      } catch (error) { reject(error) }
    })
    req.pipe(parser)
  })
}

function analysisPrompt(input: VisionInput): string {
  return [
    '请忠实分析用户提供的文件，并使用中文 Markdown 返回。',
    '覆盖主要内容、关键文字、结构布局、图表关系、重要颜色与空间位置。无法确定时明确标注“不确定”，不要臆造。',
    input.ocrText ? `以下是本地 OCR 结果，仅作为辅助并请纠错：\n${input.ocrText}` : '',
    `用户任务：${input.instruction || '完整理解这个文件'}`,
  ].filter(Boolean).join('\n\n')
}

/** OpenAI Responses API 适配器；额度/限流后熔断五分钟。 */
export class OpenAIVisionAnalyzer implements VisionAnalyzer {
  private readonly baseURL: string
  private readonly model: string
  private readonly client: OpenAI | null

  constructor(options: { apiKey?: string; baseURL?: string; model?: string } = {}) {
    const apiKey = (options.apiKey ?? process.env.VISION_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim()
    this.baseURL = (options.baseURL ?? process.env.VISION_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.model = options.model ?? process.env.VISION_MODEL ?? 'gpt-4.1-mini'
    this.client = apiKey ? new OpenAI({ apiKey, baseURL: this.baseURL }) : null
  }

  isConfigured(): boolean { return Boolean(this.client) }

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    if (!this.client) throw new Error('未配置 VISION_API_KEY。')
    const breaker = getProviderCircuitBreaker(`vision:${this.baseURL}:${this.model}`)
    if (!breaker.canAttempt()) throw new Error(`OpenAI 视觉服务暂时熔断，约 ${Math.ceil(breaker.remainingMs() / 1000)} 秒后重试。`)
    const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString('base64')}`
    const content = input.mimeType === 'application/pdf'
      ? [{ type: 'input_text' as const, text: analysisPrompt(input) }, { type: 'input_file' as const, filename: input.filename, file_data: dataUrl }]
      : [{ type: 'input_text' as const, text: analysisPrompt(input) }, { type: 'input_image' as const, image_url: dataUrl, detail: 'auto' as const }]
    try {
      const response = await this.client.responses.create({ model: this.model, input: [{ role: 'user', content }], max_output_tokens: 4_000 }, { signal: input.signal })
      const text = response.output_text?.trim()
      if (!text) throw new Error('视觉模型没有返回可用内容。')
      breaker.recordSuccess()
      return { text, provider: 'OpenAI', model: this.model }
    } catch (error) {
      breaker.recordFailure(error)
      throw error
    }
  }
}

/** Ollama 的 OpenAI-compatible Chat Completions 视觉适配器，仅处理图片。 */
export class OllamaVisionAnalyzer implements VisionAnalyzer {
  private readonly enabled: boolean
  private readonly baseURL: string
  private readonly model: string
  private readonly client: OpenAI

  constructor(options: { enabled?: boolean; baseURL?: string; model?: string } = {}) {
    this.enabled = options.enabled ?? (truthy(process.env.OLLAMA_ENABLED) || truthy(process.env.OLLAMA_VISION_ENABLED))
    this.baseURL = (options.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '')
    this.model = options.model ?? process.env.OLLAMA_VISION_MODEL ?? 'qwen3-vl:8b'
    // 8B 视觉模型在纯 CPU/共享显存机器首次推理可能超过两分钟，单独提供更宽裕的超时。
    const timeout = Math.max(30_000, Number(process.env.OLLAMA_VISION_TIMEOUT_MS) || 300_000)
    this.client = new OpenAI({ apiKey: 'ollama', baseURL: this.baseURL, timeout, maxRetries: 0 })
  }

  isConfigured(): boolean { return this.enabled }

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    if (!this.enabled) throw new Error('未启用 Ollama 视觉服务。')
    if (input.mimeType === 'application/pdf') throw new Error('Ollama 视觉端点不直接接收 PDF，将转为逐页本地解析。')
    const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString('base64')}`
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: analysisPrompt(input) }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      max_tokens: 4_000,
    }, { signal: input.signal })
    const text = response.choices[0]?.message.content?.trim()
    if (!text) throw new Error('Ollama 视觉模型没有返回可用内容。')
    return { text, provider: 'Ollama', model: this.model }
  }
}

/** 顺序尝试所有已配置视觉服务，保留最后错误供本地降级提示。 */
export class FallbackVisionAnalyzer implements VisionAnalyzer {
  constructor(private readonly analyzers: VisionAnalyzer[] = [new OpenAIVisionAnalyzer(), new OllamaVisionAnalyzer()]) {}
  isConfigured(): boolean { return this.analyzers.some((item) => item.isConfigured()) }
  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    const errors: string[] = []
    for (const analyzer of this.analyzers) {
      if (!analyzer.isConfigured()) continue
      try { return await analyzer.analyze(input) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
    }
    throw new Error(errors.join('；') || '没有可用的视觉服务。')
  }
}

export function getMultimodalProviderStatus() {
  const openai = new OpenAIVisionAnalyzer()
  const ollama = new OllamaVisionAnalyzer()
  return {
    openai: { configured: openai.isConfigured(), model: process.env.VISION_MODEL ?? 'gpt-4.1-mini' },
    ollama: { enabled: ollama.isConfigured(), model: process.env.OLLAMA_VISION_MODEL ?? 'qwen3-vl:8b', baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1' },
    localFallback: { pdfText: true, imageOcr: true, scannedPdfOcr: true },
    order: ['OpenAI', 'Ollama', 'local OCR/PDF'],
  }
}

export interface AnalyzeMediaOptions {
  analyzer?: VisionAnalyzer
  instruction?: string
  signal?: AbortSignal
  recognize?: (upload: OcrUpload) => ReturnType<typeof recognizeImage>
}

async function extractPdfLocally(upload: MediaUpload, options: AnalyzeMediaOptions, analyzer: VisionAnalyzer): Promise<MediaAnalysisResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(upload.buffer), useSystemFonts: true })
  const pdf = await loadingTask.promise
  try {
    const pageLimit = Math.min(pdf.numPages, Math.max(1, Number(process.env.PDF_MAX_OCR_PAGES) || 20))
    const sections: string[] = []
    const warnings: string[] = []
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim()
    if (text.length >= 30) {
      sections.push(`## 第 ${pageNumber} 页\n\n${text}`)
      continue
    }

    // 无文本层页面渲染成 PNG，再复用 Ollama 视觉/OCR 链路。
    const canvasApi = await import('@napi-rs/canvas')
    const viewport = page.getViewport({ scale: Math.min(2, Math.max(1, Number(process.env.PDF_OCR_SCALE) || 1.5)) })
    const canvas = canvasApi.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise
    const image = validateImageUpload(`${upload.filename}-page-${pageNumber}.png`, 'image/png', canvas.toBuffer('image/png'))
    const result = await analyzeMedia({ ...image, kind: 'image' }, { ...options, analyzer })
    if (result.analysis.trim()) sections.push(`## 第 ${pageNumber} 页（扫描页）\n\n${result.analysis}`)
    if (result.warning) warnings.push(`第 ${pageNumber} 页：${result.warning}`)
    }
    if (pdf.numPages > pageLimit) warnings.push(`PDF 共 ${pdf.numPages} 页，本次按 PDF_MAX_OCR_PAGES 上限仅处理前 ${pageLimit} 页。`)
    if (!sections.length) throw new Error('PDF 没有可提取或可识别的内容。')
    return {
      type: 'pdf', filename: upload.filename, mimeType: upload.mimeType,
      analysis: sections.join('\n\n').slice(0, MEDIA_UPLOAD_RULES.maxAnalysisChars),
      mode: 'local-pdf', provider: 'local', model: 'pdfjs+ocr',
      warning: warnings.length ? warnings.join('；') : undefined,
    }
  } finally {
    // pdf.js 在 Node 中持有 worker/字体资源，主动销毁避免服务和测试残留句柄。
    await pdf.cleanup()
    await loadingTask.destroy()
  }
}

/** 执行完整降级链：云端失败不会阻断本地可完成的解析。 */
export async function analyzeMedia(upload: MediaUpload, options: AnalyzeMediaOptions = {}): Promise<MediaAnalysisResult> {
  const analyzer = options.analyzer ?? new FallbackVisionAnalyzer()
  const instruction = options.instruction ?? '完整理解这个文件'
  let ocrText = ''
  let confidence: number | undefined
  if (upload.kind === 'image') {
    const recognized = await (options.recognize ?? recognizeImage)({ filename: upload.filename, mimeType: upload.mimeType, buffer: upload.buffer, width: upload.width!, height: upload.height! })
    ocrText = recognized.text.trim()
    confidence = recognized.confidence
  }

  let visionError = ''
  if (analyzer.isConfigured()) {
    try {
      const vision = await analyzer.analyze({ filename: upload.filename, mimeType: upload.mimeType, buffer: upload.buffer, instruction, ocrText, signal: options.signal })
      return { type: upload.kind, filename: upload.filename, mimeType: upload.mimeType, analysis: vision.text.slice(0, MEDIA_UPLOAD_RULES.maxAnalysisChars), ocrText: ocrText || undefined, confidence, mode: ocrText ? 'hybrid' : 'vision', provider: vision.provider, model: vision.model }
    } catch (error) { visionError = error instanceof Error ? error.message : String(error) }
  }

  if (upload.kind === 'pdf') {
    try {
      const local = await extractPdfLocally(upload, options, analyzer)
      if (visionError) local.warning = `视觉服务不可用，已切换本地 PDF 解析：${visionError}${local.warning ? `；${local.warning}` : ''}`
      return local
    } catch (error) {
      throw new AppError(ErrorCodes.OcrFailed, `PDF 本地解析失败：${error instanceof Error ? error.message : String(error)}`, 503, 'media_analysis', true)
    }
  }

  if (ocrText) return { type: 'image', filename: upload.filename, mimeType: upload.mimeType, analysis: ocrText, ocrText, confidence, mode: 'ocr', warning: visionError ? `视觉分析失败，已退回本地 OCR：${visionError}` : '未配置视觉模型，当前仅提供本地 OCR。' }
  throw new AppError(ErrorCodes.OcrFailed, '图片没有识别出文字；启用 Ollama 视觉模型后可理解无文字图片。', 503, 'media_analysis', true)
}
