/**
 * 本地输出目录（工作区）管理。
 * 配置持久化到 .deepagent/workspaces.json。
 * 路径完全由使用者自行添加/修改，可为任意本机绝对路径。
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

export interface WorkspaceFolder {
  id: string
  name: string
  /** 绝对路径 */
  path: string
  createdAt: number
  updatedAt: number
}

export interface WorkspaceState {
  activeId: string
  folders: WorkspaceFolder[]
}

const CONFIG_DIR = path.resolve(process.cwd(), '.deepagent')
const CONFIG_FILE = path.join(CONFIG_DIR, 'workspaces.json')

function defaultOutputPath(): string {
  return path.resolve(process.cwd(), 'output')
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function normalizeAbsPath(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, '')
  if (!trimmed) throw new Error('路径不能为空')
  // Windows 允许用户粘贴正斜杠
  return path.resolve(trimmed)
}

function loadRaw(): WorkspaceState | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as WorkspaceState
    if (!raw?.folders?.length || !raw.activeId) return null
    return raw
  } catch {
    return null
  }
}

function saveRaw(state: WorkspaceState): void {
  ensureDir(CONFIG_DIR)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

export class WorkspaceStore {
  private state: WorkspaceState

  constructor() {
    const loaded = loadRaw()
    if (loaded) {
      this.state = loaded
      // 确保激活项存在
      if (!this.state.folders.some((f) => f.id === this.state.activeId)) {
        this.state.activeId = this.state.folders[0].id
        saveRaw(this.state)
      }
    } else {
      const now = Date.now()
      const id = randomUUID()
      this.state = {
        activeId: id,
        folders: [
          {
            id,
            name: '项目 output',
            path: defaultOutputPath(),
            createdAt: now,
            updatedAt: now,
          },
        ],
      }
      saveRaw(this.state)
    }
  }

  list(): WorkspaceFolder[] {
    return [...this.state.folders].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getActive(): WorkspaceFolder {
    const active = this.state.folders.find((f) => f.id === this.state.activeId)
    if (active) return active
    return this.state.folders[0]
  }

  getActivePath(): string {
    return this.getActive().path
  }

  get(id: string): WorkspaceFolder | undefined {
    return this.state.folders.find((f) => f.id === id)
  }

  add(name: string, folderPath: string): WorkspaceFolder {
    const abs = normalizeAbsPath(folderPath)
    ensureDir(abs)

    const now = Date.now()
    const folder: WorkspaceFolder = {
      id: randomUUID(),
      name: (name || path.basename(abs) || '工作区').trim(),
      path: abs,
      createdAt: now,
      updatedAt: now,
    }
    this.state.folders.push(folder)
    this.state.activeId = folder.id
    saveRaw(this.state)
    return folder
  }

  update(
    id: string,
    patch: { name?: string; path?: string },
  ): WorkspaceFolder {
    const folder = this.state.folders.find((f) => f.id === id)
    if (!folder) throw new Error('工作区不存在')

    if (patch.name !== undefined) {
      const n = patch.name.trim()
      if (!n) throw new Error('名称不能为空')
      folder.name = n
    }
    if (patch.path !== undefined) {
      const abs = normalizeAbsPath(patch.path)
      ensureDir(abs)
      folder.path = abs
    }
    folder.updatedAt = Date.now()
    saveRaw(this.state)
    return folder
  }

  setActive(id: string): WorkspaceFolder {
    const folder = this.state.folders.find((f) => f.id === id)
    if (!folder) throw new Error('工作区不存在')
    this.state.activeId = id
    saveRaw(this.state)
    return folder
  }

  remove(id: string): WorkspaceState {
    if (this.state.folders.length <= 1) {
      throw new Error('至少保留一个输出目录')
    }
    const idx = this.state.folders.findIndex((f) => f.id === id)
    if (idx < 0) throw new Error('工作区不存在')
    this.state.folders.splice(idx, 1)
    if (this.state.activeId === id) {
      this.state.activeId = this.state.folders[0].id
    }
    saveRaw(this.state)
    return this.state
  }

  snapshot() {
    return {
      activeId: this.state.activeId,
      folders: this.list(),
      active: this.getActive(),
    }
  }
}
