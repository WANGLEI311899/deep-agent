import assert from 'node:assert/strict'
import test from 'node:test'
import { createSandBox } from '../dist/sandbox.mjs'

test('沙箱写入正常路径', () => {
  const sb = createSandBox({
    outputPath: 'output/test-sandbox',
    verbose: false,
  })
  const p = sb.writeFile('hello.txt', 'Hello')
  assert.ok(p.endsWith('hello.txt'))
  assert.ok(sb.isPathSafe('hello.txt'))
})

test('沙箱阻止 ../ 路径穿越', () => {
  const sb = createSandBox({
    outputPath: 'output/test-sandbox',
    verbose: false,
  })
  assert.equal(sb.isPathSafe('../outside.txt'), false)
  assert.equal(sb.isPathSafe('..\\Windows\\System32'), false)
  assert.equal(sb.isPathSafe('sub/../../../etc'), false)
  assert.throws(() => sb.writeFile('../outside.txt', 'x'))
})

test('沙箱允许输出目录内的子目录', () => {
  const sb = createSandBox({
    outputPath: 'output/test-sandbox',
    verbose: false,
  })
  assert.ok(sb.isPathSafe('sub/file.txt'))
  assert.ok(sb.isPathSafe('sub/deep/file.txt'))
})

test('沙箱 listFiles 返回相对路径列表', () => {
  const sb = createSandBox({
    outputPath: 'output/test-sandbox',
    verbose: false,
  })
  sb.writeFile('a.txt', 'a')
  sb.writeFile('b/c.txt', 'c')
  const files = sb.listFiles()
  assert.ok(files.includes('a.txt'))
  assert.ok(files.includes('b\\c.txt') || files.includes('b/c.txt'))
})

test('沙箱 readFile 读取写入的文件', () => {
  const sb = createSandBox({
    outputPath: 'output/test-sandbox',
    verbose: false,
  })
  sb.writeFile('readme.txt', 'content')
  assert.equal(sb.readFile('readme.txt'), 'content')
  assert.equal(sb.readFile('nonexist.txt'), null)
})

test('沙箱 isPathSafe 阻止绝对路径（不在输出目录内）', () => {
  const sb = createSandBox({
    outputPath: 'output/test-sandbox',
    verbose: false,
  })
  assert.equal(sb.isPathSafe('/etc/passwd'), false)
  assert.equal(sb.isPathSafe('C:\\Windows\\System32'), false)
})
