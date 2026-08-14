import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import {
  analyzeMedia,
  validateMediaUpload,
} from '../dist/multimodal/media-service.mjs'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAusB9Y9Z7YUAAAAASUVORK5CYII=',
  'base64',
)
const PDF_MINIMAL = Buffer.from('%PDF-1.4\n%%EOF\n')

test('多模态上传接受真实 PDF 并拒绝伪装 PDF', () => {
  const upload = validateMediaUpload('report.pdf', 'application/pdf', PDF_MINIMAL)
  assert.equal(upload.kind, 'pdf')
  assert.throws(
    () => validateMediaUpload('fake.pdf', 'application/pdf', Buffer.from('not pdf')),
    (error) => error.code === 'OCR_INVALID_IMAGE',
  )
})

test('图片同时组合本地 OCR 与视觉模型结果', async () => {
  const upload = validateMediaUpload('chart.png', 'image/png', PNG_1X1)
  let receivedOcr = ''
  const result = await analyzeMedia(upload, {
    recognize: async () => ({
      filename: 'chart.png',
      mimeType: 'image/png',
      text: '销售额 120',
      confidence: 93,
    }),
    analyzer: {
      isConfigured: () => true,
      analyze: async (input) => {
        receivedOcr = input.ocrText
        return { text: '柱状图显示销售额为 120。', provider: 'mock', model: 'vision-test' }
      },
    },
  })
  assert.equal(receivedOcr, '销售额 120')
  assert.equal(result.mode, 'hybrid')
  assert.match(result.analysis, /柱状图/)
  assert.equal(result.model, 'vision-test')
})

test('视觉模型失败时图片自动降级为 OCR', async () => {
  const upload = validateMediaUpload('screen.png', 'image/png', PNG_1X1)
  const result = await analyzeMedia(upload, {
    recognize: async () => ({
      filename: 'screen.png',
      mimeType: 'image/png',
      text: '登录按钮',
      confidence: 88,
    }),
    analyzer: {
      isConfigured: () => true,
      analyze: async () => { throw new Error('mock timeout') },
    },
  })
  assert.equal(result.mode, 'ocr')
  assert.equal(result.analysis, '登录按钮')
  assert.match(result.warning, /mock timeout/)
})

test('PDF 使用视觉文件输入并返回结构化分析', async () => {
  const upload = validateMediaUpload('contract.pdf', 'application/pdf', PDF_MINIMAL)
  const result = await analyzeMedia(upload, {
    analyzer: {
      isConfigured: () => true,
      analyze: async (input) => {
        assert.equal(input.mimeType, 'application/pdf')
        return { text: '# 合同\n\n金额：100 元', provider: 'mock', model: 'vision-test' }
      },
    },
  })
  assert.equal(result.mode, 'vision')
  assert.match(result.analysis, /金额/)
})

async function createTextPdf(text) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  page.drawText(text, { x: 72, y: 720, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) })
  return Buffer.from(await pdf.save())
}

test('没有视觉配置时 PDF 自动使用本地文本层解析', async () => {
  const upload = validateMediaUpload('local.pdf', 'application/pdf', await createTextPdf('Hello local PDF fallback'))
  const result = await analyzeMedia(upload, {
    analyzer: {
      isConfigured: () => false,
      analyze: async () => { throw new Error('不应调用') },
    },
  })
  assert.equal(result.mode, 'local-pdf')
  assert.equal(result.provider, 'local')
  assert.match(result.analysis, /Hello local PDF fallback/)
})

test('损坏 PDF 在本地解析失败时返回可重试错误', async () => {
  const upload = validateMediaUpload('scan.pdf', 'application/pdf', PDF_MINIMAL)
  await assert.rejects(
    analyzeMedia(upload, {
      analyzer: {
        isConfigured: () => false,
        analyze: async () => { throw new Error('不应调用') },
      },
    }),
    (error) => error.code === 'OCR_FAILED' && /PDF 本地解析失败/.test(error.message),
  )
})
