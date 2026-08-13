/**
 * OCR 上传与识别服务。
 * 图片仅在内存中存在，不写入工作区或会话文件，避免长期保存用户原图。
 */
import type http from 'http'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import Busboy from 'busboy'
import { createWorker, type Worker } from 'tesseract.js'
import { AppError, ErrorCodes } from '../errors.js'

export const OCR_UPLOAD_RULES = {
  maxFiles: 1,
  // 前后端和提示文案统一固定为 10 MB，避免配置漂移导致用户看到错误规则。
  maxBytes: 10 * 1024 * 1024,
  maxPixels: Math.max(1, Number(process.env.OCR_MAX_IMAGE_PIXELS ?? 25_000_000)),
  maxTextChars: Math.max(1, Number(process.env.OCR_MAX_TEXT_CHARS ?? 20_000)),
  extensions: ['.jpg', '.jpeg', '.png', '.webp'],
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
} as const

export const OCR_UPLOAD_HINT = '仅支持 JPG/JPEG、PNG、WebP 格式；每次只能上传 1 张图片；单张不超过 10 MB。'

export interface OcrUpload {
  filename: string
  mimeType: string
  buffer: Buffer
  width: number
  height: number
}

export interface OcrResult {
  id: string
  filename: string
  mimeType: string
  text: string
  confidence: number
  language: string
  warnings: string[]
}

function invalidImage(message: string): AppError {
  return new AppError(
    ErrorCodes.OcrInvalidImage,
    `${message} ${OCR_UPLOAD_HINT}`,
    400,
    'ocr_upload_validation',
  )
}

/** 根据真实文件头判断类型，不能只信任浏览器提交的扩展名和 MIME。 */
function sniffMime(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }
    while (buffer[offset] === 0xff) offset++
    const marker = buffer[offset++]
    if (marker === 0xd8 || marker === 0xd9) continue
    if (offset + 2 > buffer.length) return null
    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null
    if (sofMarkers.has(marker) && segmentLength >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      }
    }
    offset += segmentLength
  }
  return null
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii')
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const data = offset + 8
    if (data + chunkSize > buffer.length) return null
    if (type === 'VP8X' && chunkSize >= 10) {
      return { width: 1 + buffer.readUIntLE(data + 4, 3), height: 1 + buffer.readUIntLE(data + 7, 3) }
    }
    if (type === 'VP8 ' && chunkSize >= 10 && buffer.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return { width: buffer.readUInt16LE(data + 6) & 0x3fff, height: buffer.readUInt16LE(data + 8) & 0x3fff }
    }
    if (type === 'VP8L' && chunkSize >= 5 && buffer[data] === 0x2f) {
      const bits = buffer.readUInt32LE(data + 1)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
    offset = data + chunkSize + (chunkSize % 2)
  }
  return null
}

/** 仅解析白名单格式的尺寸头，避免把不需要的复杂图片解析器暴露给上传内容。 */
function readDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (mimeType === 'image/jpeg') return readJpegDimensions(buffer)
  if (mimeType === 'image/webp') return readWebpDimensions(buffer)
  return null
}

export function validateImageUpload(
  filename: string,
  declaredMime: string,
  buffer: Buffer,
): OcrUpload {
  const extension = path.extname(filename).toLowerCase()
  if (!OCR_UPLOAD_RULES.extensions.includes(extension as never)) {
    throw invalidImage(`“${filename || '未命名文件'}”的文件格式不正确。`)
  }
  if (!OCR_UPLOAD_RULES.mimeTypes.includes(declaredMime as never)) {
    throw invalidImage(`“${filename}”不是受支持的图片类型。`)
  }
  if (!buffer.length) throw invalidImage('上传的图片内容为空。')
  if (buffer.length > OCR_UPLOAD_RULES.maxBytes) {
    throw new AppError(
      ErrorCodes.OcrImageTooLarge,
      `图片超过 10 MB。${OCR_UPLOAD_HINT}`,
      413,
      'ocr_upload_validation',
    )
  }

  const actualMime = sniffMime(buffer)
  if (!actualMime || actualMime !== declaredMime) {
    throw invalidImage('图片扩展名、文件类型或真实内容不一致。')
  }

  try {
    const dimensions = readDimensions(buffer, actualMime)
    const width = dimensions?.width ?? 0
    const height = dimensions?.height ?? 0
    if (!width || !height) throw new Error('无法读取图片尺寸')
    if (width * height > OCR_UPLOAD_RULES.maxPixels) {
      throw new AppError(
        ErrorCodes.OcrImageTooLarge,
        `图片分辨率过大，最多允许 ${OCR_UPLOAD_RULES.maxPixels.toLocaleString('zh-CN')} 像素。${OCR_UPLOAD_HINT}`,
        413,
        'ocr_upload_validation',
      )
    }
    return { filename: path.basename(filename), mimeType: actualMime, buffer, width, height }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalidImage('图片已损坏或无法解析。')
  }
}

/** 使用带上限的流式 multipart 解析，避免把无限请求体一次性读入内存。 */
export function readOcrUpload(req: http.IncomingMessage): Promise<OcrUpload> {
  return new Promise((resolve, reject) => {
    let busboy: Busboy.Busboy
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: OCR_UPLOAD_RULES.maxBytes, fields: 0, parts: 2 },
      })
    } catch {
      reject(invalidImage('请求必须使用 multipart/form-data 上传图片。'))
      return
    }

    let upload: Promise<OcrUpload> | null = null
    let filesLimitReached = false
    let settled = false
    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    busboy.on('file', (_field, stream, info) => {
      const chunks: Buffer[] = []
      let truncated = false
      stream.on('limit', () => {
        truncated = true
      })
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      upload = new Promise<OcrUpload>((fileResolve, fileReject) => {
        stream.on('end', () => {
          if (truncated) {
            fileReject(new AppError(
              ErrorCodes.OcrImageTooLarge,
              `图片超过 10 MB。${OCR_UPLOAD_HINT}`,
              413,
              'ocr_upload_validation',
            ))
            return
          }
          try {
            fileResolve(validateImageUpload(info.filename, info.mimeType, Buffer.concat(chunks)))
          } catch (error) {
            fileReject(error)
          }
        })
        stream.on('error', fileReject)
      })
      // Busboy 的 finish 晚于文件流 end；先挂一个观察器，避免校验失败在 await 前被 Node 判为未处理拒绝。
      void upload.catch(() => undefined)
    })
    busboy.on('filesLimit', () => {
      filesLimitReached = true
    })
    busboy.on('error', finishReject)
    busboy.on('finish', async () => {
      if (filesLimitReached) {
        finishReject(new AppError(
          ErrorCodes.OcrTooManyImages,
          `一次只能上传 1 张图片。${OCR_UPLOAD_HINT}`,
          400,
          'ocr_upload_validation',
        ))
        return
      }
      if (!upload) {
        finishReject(invalidImage('没有收到图片。'))
        return
      }
      try {
        const parsed = await upload
        if (!settled) {
          settled = true
          resolve(parsed)
        }
      } catch (error) {
        finishReject(error)
      }
    })
    req.pipe(busboy)
  })
}

// 英文放在首位可避开部分 Tesseract WASM 版本以中文开头加载多语言时的初始化异常。
const languages = process.env.OCR_LANGUAGES?.trim() || 'eng+chi_sim'
const languageCodes = languages.split('+').map((item) => item.trim()).filter(Boolean)
let workerPromise: Promise<Worker> | null = null
let recognitionQueue: Promise<void> = Promise.resolve()

const require = createRequire(import.meta.url)

/**
 * 将 npm 随包安装的快速语言模型汇总到可写缓存目录。
 * Tesseract 的多语言 Worker 只接受一个 langPath，因此中英文文件需要位于同一目录。
 */
function ensureLocalLanguagePath(): string {
  const configured = process.env.OCR_LANG_PATH?.trim()
  if (configured) return path.resolve(configured)

  const supported = new Set(['chi_sim', 'eng'])
  const requested = languageCodes
  if (requested.some((language) => !supported.has(language))) {
    throw new Error(`OCR_LANGUAGES=${languages} 包含未内置的语言，请同时配置 OCR_LANG_PATH。`)
  }

  const targetDir = path.resolve(process.cwd(), '.deepcodex', 'ocr-langs')
  fs.mkdirSync(targetDir, { recursive: true })
  for (const language of requested) {
    const dataPackage = require(`@tesseract.js-data/${language}`) as { langPath: string }
    const source = path.resolve(dataPackage.langPath, '..', '4.0.0_best_int', `${language}.traineddata.gz`)
    const target = path.join(targetDir, `${language}.traineddata.gz`)
    const shouldCopy = !fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size
    if (shouldCopy) fs.copyFileSync(source, target)
  }
  return targetDir
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // Worker 首次使用时加载语言数据，后续请求复用，显著降低连续识别耗时。
    workerPromise = createWorker(languageCodes, undefined, {
      langPath: ensureLocalLanguagePath(),
      gzip: true,
      // 语言压缩包已由项目管理；禁用 Tesseract 默认的 cwd 解压缓存，避免污染仓库根目录。
      cacheMethod: 'none',
    }).catch((error) => {
      workerPromise = null
      throw error
    })
  }
  return workerPromise
}

export async function recognizeImage(upload: OcrUpload): Promise<Omit<OcrResult, 'id'>> {
  let release!: () => void
  const previous = recognitionQueue
  recognitionQueue = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    const worker = await getWorker()
    const result = await worker.recognize(upload.buffer)
    const rawText = result.data.text.trim()
    const truncated = rawText.length > OCR_UPLOAD_RULES.maxTextChars
    return {
      filename: upload.filename,
      mimeType: upload.mimeType,
      text: rawText.slice(0, OCR_UPLOAD_RULES.maxTextChars),
      confidence: Number(result.data.confidence.toFixed(2)),
      language: languages,
      warnings: truncated ? [`识别结果超过 ${OCR_UPLOAD_RULES.maxTextChars} 字，已截断。`] : [],
    }
  } catch (error) {
    throw new AppError(
      ErrorCodes.OcrFailed,
      '图片文字识别失败，请检查图片是否清晰后重试。',
      502,
      'ocr_recognition',
      true,
      { cause: error },
    )
  } finally {
    release()
  }
}

export async function terminateOcrWorker(): Promise<void> {
  const pending = workerPromise
  workerPromise = null
  if (pending) await (await pending).terminate()
}
