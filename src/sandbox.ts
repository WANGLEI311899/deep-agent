// 沙箱模块：所有文件操作都限制在配置的输出目录内。
import fs from 'node:fs'
import path from 'node:path'

export interface SandboxConfig {
  /** 工作区真实目录 */
  workspacePath: string
  /** 相对于工作区的输出目录 */
  outputDir?: string
  /** 是否打印文件操作日志 */
  verbose?: boolean
}

export interface SandboxContent {
  workspacePath: string
  outputDir: string
  writeFile: (filename: string, content: string) => string
  /** 兼容早期版本中的拼写，后续代码应优先使用 writeFile。 */
  wirteFile: (filename: string, content: string) => string
  readFile: (filename: string) => string | null
  listFiles: () => string[]
  isPathSafe: (targetPath: string) => boolean
}

/** 创建沙箱上下文，并阻止通过 ../ 或绝对路径访问输出目录之外的文件。 */
export function createSandBox(config: SandboxConfig): SandboxContent {
  const workspacePath = path.resolve(config.workspacePath)
  const outputDir = config.outputDir || 'output'
  const outputPath = path.resolve(workspacePath, outputDir)
  const verbose = config.verbose ?? true

  fs.mkdirSync(outputPath, { recursive: true })

  if (verbose) {
    console.log('[Sandbox] 工作区初始化完成')
    console.log(`[Sandbox]   真实路径：${workspacePath}`)
    console.log(`[Sandbox]   输出目录：${outputPath}`)
  }

  function isPathSafe(targetPath: string): boolean {
    const resolved = path.resolve(outputPath, targetPath)
    const relative = path.relative(outputPath, resolved)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  function writeFile(filename: string, content: string): string {
    if (!isPathSafe(filename)) {
      throw new Error(`[Sandbox] 安全拦截：路径越界，无法写入 ${filename}`)
    }

    const targetPath = path.resolve(outputPath, filename)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, content, 'utf-8')

    if (verbose) {
      console.log(`[Sandbox] 文件已写入：${path.relative(workspacePath, targetPath)}`)
    }
    return targetPath
  }

  function readFile(filename: string): string | null {
    if (!isPathSafe(filename)) {
      console.warn(`[Sandbox] 安全拦截：路径越界，无法读取 ${filename}`)
      return null
    }

    const targetPath = path.resolve(outputPath, filename)
    return fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : null
  }

  function listFiles(): string[] {
    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(dir, entry.name)
        return entry.isDirectory()
          ? walk(fullPath)
          : [path.relative(outputPath, fullPath)]
      })
    }

    return fs.existsSync(outputPath) ? walk(outputPath) : []
  }

  return {
    workspacePath,
    outputDir,
    writeFile,
    wirteFile: writeFile,
    readFile,
    listFiles,
    isPathSafe,
  }
}
