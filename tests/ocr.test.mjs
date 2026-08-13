import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OCR_UPLOAD_HINT,
  validateImageUpload,
} from '../dist/ocr/ocr-service.mjs'

// 1×1 PNG，用于验证无需调用 OCR 引擎的上传格式检查。
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('OCR 接受扩展名、MIME 和文件头一致的 PNG', () => {
  const upload = validateImageUpload('screen.png', 'image/png', PNG_1X1)
  assert.equal(upload.mimeType, 'image/png')
  assert.equal(upload.width, 1)
  assert.equal(upload.height, 1)
})

test('OCR 拒绝不支持的格式并返回完整上传要求', () => {
  assert.throws(
    () => validateImageUpload('screen.gif', 'image/gif', PNG_1X1),
    (error) => {
      assert.equal(error.code, 'OCR_INVALID_IMAGE')
      assert.match(error.message, /JPG\/JPEG、PNG、WebP/)
      assert.match(error.message, /只能上传 1 张/)
      assert.match(error.message, /10 MB/)
      assert.ok(error.message.includes(OCR_UPLOAD_HINT))
      return true
    },
  )
})

test('OCR 拒绝扩展名与真实文件内容不一致的伪装图片', () => {
  assert.throws(
    () => validateImageUpload('screen.jpg', 'image/jpeg', PNG_1X1),
    (error) => error.code === 'OCR_INVALID_IMAGE',
  )
})
