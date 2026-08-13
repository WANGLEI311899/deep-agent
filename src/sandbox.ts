// 沙箱模块：文件操作限制在配置的输出目录内，支持绝对路径输出目录。
import fs from 'node:fs'
import path from 'node:path'

export interface SandboxConfig {
  /** 工作区真实目录（相对 outputDir 时使用） */
  workspacePath?: string
  /** 相对于工作区的输出目录 */
  outputDir?: string
  /**
   * 绝对输出目录（优先）。
   * 由使用者自行配置任意本机路径，例如 D:\\work\\notes
   */
  outputPath?: string
  /** 是否打印文件操作日志 */
  verbose?: boolean
}

export interface SandboxContent {
  workspacePath: string
  /** 展示用：目录名或完整路径 */
  outputDir: string
  /** 绝对输出路径 */
  outputPath: string
  writeFile: (filename: string, content: string) => string
  /** @deprecated 拼写错误别名，请使用 writeFile。将在 v2.0 中移除。 */
  wirteFile: (filename: string, content: string) => string
  readFile: (filename: string) => string | null
  listFiles: () => string[]
  isPathSafe: (targetPath: string) => boolean
}

function resolveOutputPath(config: SandboxConfig): {
  workspacePath: string
  outputPath: string
  outputDirLabel: string
} {
  if (config.outputPath && config.outputPath.trim()) {
    const outputPath = path.resolve(config.outputPath.trim())
    return {
      workspacePath: path.resolve(config.workspacePath || process.cwd()),
      outputPath,
      outputDirLabel: outputPath,
    }
  }

  const workspacePath = path.resolve(config.workspacePath || process.cwd())
  const outputDir = config.outputDir || 'output'
  const outputPath = path.isAbsolute(outputDir)
    ? path.resolve(outputDir)
    : path.resolve(workspacePath, outputDir)

  return {
    workspacePath,
    outputPath,
    outputDirLabel: outputDir,
  }
}

/** 创建沙箱上下文，并阻止通过 ../ 访问输出目录之外的文件。 */
export function createSandBox(config: SandboxConfig): SandboxContent {
  const { workspacePath, outputPath, outputDirLabel } = resolveOutputPath(config)
  const verbose = config.verbose ?? true

  fs.mkdirSync(outputPath, { recursive: true })

  if (verbose) {
    console.log('[Sandbox] 工作区初始化完成')
    console.log(`[Sandbox]   项目路径：${workspacePath}`)
    console.log(`[Sandbox]   输出目录：${outputPath}`)
  }

  /** 逐级向上解析符号链接，拿到真实磁盘路径。 */
  function resolveRealPath(targetPath: string): string {
    try {
      return fs.realpathSync(targetPath)
    } catch {
      // 路径尚不存在（常见于 writeFile 之前）：逐级向上查找存在的父目录
      let current = targetPath
      while (current !== path.dirname(current)) {
        try {
          const realParent = fs.realpathSync(path.dirname(current))
          return path.join(realParent, path.basename(current))
        } catch {
          current = path.dirname(current)
        }
      }
      return targetPath
    }
  }

  function isPathSafe(targetPath: string): boolean {
    // Step 1: 计算出期望的绝对路径
    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(outputPath, targetPath)

    // Step 2: 解析符号链接到真实磁盘路径
    const realTarget = resolveRealPath(resolved)

    // Step 3: 输出目录本身也可能是符号链接，同样解析真实路径
    const realOutput = (() => {
      try { return fs.realpathSync(outputPath) } catch { return outputPath }
    })()

    // Step 4: 校验真实路径是否在输出目录内
    const relative = path.relative(realOutput, realTarget)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  function writeFile(filename: string, content: string): string {
    if (!isPathSafe(filename)) {
      throw new Error(`[Sandbox] 安全拦截：路径越界，无法写入 ${filename}`)
    }

    const targetPath = path.isAbsolute(filename)
      ? path.resolve(filename)
      : path.resolve(outputPath, filename)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, content, 'utf-8')

    if (verbose) {
      console.log(`[Sandbox] 文件已写入：${targetPath}`)
    }
    return targetPath
  }

  function readFile(filename: string): string | null {
    if (!isPathSafe(filename)) {
      console.warn(`[Sandbox] 安全拦截：路径越界，无法读取 ${filename}`)
      return null
    }

    const targetPath = path.isAbsolute(filename)
      ? path.resolve(filename)
      : path.resolve(outputPath, filename)
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
    outputDir: outputDirLabel,
    outputPath,
    writeFile,
    wirteFile: writeFile,
    readFile,
    listFiles,
    isPathSafe,
  }
}
