/**
 * 多会话管理：维护会话列表、UI 消息时间线、Agent 模型上下文。
 * 持久化到 .deepcodex/sessions.json，服务重启后可恢复。
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { AgentMessage } from './agent.js'

export type ToolStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'success'
  | 'error'
  | 'cancelled'

export interface ToolCallEvent {
  id: string
  name: string
  title: string
  status: ToolStatus
  input?: unknown
  output?: unknown
  riskLevel?: 'low' | 'medium' | 'high'
  startedAt: number
  endedAt?: number
}

export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tools?: ToolCallEvent[]
  filesWritten?: string[]
  /** 图片原件不落盘；这里只保留 OCR 结果摘要供历史消息恢复展示。 */
  attachments?: MessageAttachment[]
  createdAt: number
}

export interface MessageAttachment {
  type: 'ocr'
  filename: string
  mimeType: string
  text: string
  confidence?: number
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview: string
}

export interface Session {
  id: string
  /** 会话所有者；所有读写操作必须带同一 userId。 */
  userId: string
  title: string
  createdAt: number
  updatedAt: number
  /** 展示用消息（含工具卡片） */
  uiMessages: UiMessage[]
  /** 喂给模型的上下文 */
  agentHistory: AgentMessage[]
  filesWritten: string[]
}

interface PersistedState {
  activeId?: string | null
  activeIds?: Record<string, string>
  sessions: Session[]
}

const CONFIG_DIR = path.resolve(process.cwd(), '.deepcodex')
const CONFIG_FILE = path.join(CONFIG_DIR, 'sessions.json')
const SAVE_DEBOUNCE_MS = 200

function makeTitle(seed: string): string {
  const t = seed.replace(/\s+/g, ' ').trim()
  if (!t) return '新对话'
  return t.length > 28 ? `${t.slice(0, 28)}…` : t
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false
  const s = value as Session
  return (
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    Array.isArray(s.uiMessages) &&
    Array.isArray(s.agentHistory) &&
    Array.isArray(s.filesWritten)
  )
}

function loadRaw(): PersistedState | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as PersistedState
    if (!raw || !Array.isArray(raw.sessions)) return null
    const sessions = raw.sessions.filter(isSession)
    if (!sessions.length) return null
    let activeId = raw.activeId
    if (!activeId || !sessions.some((s) => s.id === activeId)) {
      activeId = sessions[0].id
    }
    return { activeId, activeIds: raw.activeIds, sessions }
  } catch (err) {
    console.warn('[SessionStore] 读取持久化失败，将使用空状态：', err)
    return null
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>()
  private activeIds = new Map<string, string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private persistEnabled: boolean

  constructor(options: { persist?: boolean } = {}) {
    this.persistEnabled = options.persist !== false
    const loaded = this.persistEnabled ? loadRaw() : null
    if (loaded) {
      for (const s of loaded.sessions) {
        // 旧数据没有 userId，迁移到 owner，避免升级后数据丢失。
        if (!s.userId) s.userId = 'owner'
        this.sessions.set(s.id, s)
      }
      for (const [userId, id] of Object.entries(loaded.activeIds ?? {})) {
        if (this.sessions.get(id)?.userId === userId) {
          this.activeIds.set(userId, id)
        }
      }
      if (loaded.activeId && this.sessions.has(loaded.activeId)) {
        const legacy = this.sessions.get(loaded.activeId)!
        if (!this.activeIds.has(legacy.userId)) {
          this.activeIds.set(legacy.userId, legacy.id)
        }
      }
      console.log(
        `[SessionStore] 已恢复 ${this.sessions.size} 个会话（${CONFIG_FILE}）`,
      )
    }
  }

  private scheduleSave(): void {
    if (!this.persistEnabled) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /** 立即写入磁盘（进程退出前可调用） */
  flush(): void {
    if (!this.persistEnabled) return
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      const state: PersistedState = {
        activeIds: Object.fromEntries(this.activeIds),
        sessions: [...this.sessions.values()],
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      console.error('[SessionStore] 持久化失败：', err)
    }
  }

  create(userId: string, title = '新对话'): Session {
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      userId,
      title,
      createdAt: now,
      updatedAt: now,
      uiMessages: [],
      agentHistory: [],
      filesWritten: [],
    }
    this.sessions.set(session.id, session)
    this.activeIds.set(userId, session.id)
    this.scheduleSave()
    return session
  }

  ensureActive(userId: string): Session {
    const activeId = this.activeIds.get(userId)
    if (activeId) {
      const s = this.sessions.get(activeId)
      if (s?.userId === userId) return s
    }
    return this.create(userId)
  }

  get(id: string, userId: string): Session | undefined {
    const session = this.sessions.get(id)
    return session?.userId === userId ? session : undefined
  }

  getActiveId(userId: string): string | null {
    return this.activeIds.get(userId) ?? null
  }

  setActive(id: string, userId: string): Session | undefined {
    const s = this.get(id, userId)
    if (!s) return undefined
    this.activeIds.set(userId, id)
    this.scheduleSave()
    return s
  }

  list(userId: string): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => {
        const lastUser = [...s.uiMessages]
          .reverse()
          .find((m) => m.role === 'user')
        const lastAny = s.uiMessages[s.uiMessages.length - 1]
        return {
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.uiMessages.length,
          preview: (lastUser?.content || lastAny?.content || '').slice(0, 60),
        }
      })
  }

  delete(id: string, userId: string): boolean {
    if (!this.get(id, userId)) return false
    const ok = this.sessions.delete(id)
    if (this.activeIds.get(userId) === id) {
      const remaining = [...this.sessions.values()].filter(
        (session) => session.userId === userId,
      )
      const nextId = remaining.length
        ? remaining.sort((a, b) => b.updatedAt - a.updatedAt)[0]
            ?.id ?? null
        : null
      if (nextId) this.activeIds.set(userId, nextId)
      else this.activeIds.delete(userId)
    }
    if (ok) this.scheduleSave()
    return ok
  }

  touch(session: Session, firstUserMessage?: string): void {
    session.updatedAt = Date.now()
    if (
      firstUserMessage &&
      (session.title === '新对话' || session.uiMessages.length <= 1)
    ) {
      session.title = makeTitle(firstUserMessage)
    }
    this.scheduleSave()
  }

  addUiMessage(session: Session, message: UiMessage): void {
    session.uiMessages.push(message)
    this.touch(session)
  }

  updateUiMessage(
    session: Session,
    messageId: string,
    patch: Partial<UiMessage>,
  ): UiMessage | undefined {
    const msg = session.uiMessages.find((m) => m.id === messageId)
    if (!msg) return undefined
    Object.assign(msg, patch)
    this.touch(session)
    return msg
  }

  upsertTool(
    session: Session,
    messageId: string,
    tool: ToolCallEvent,
  ): void {
    const msg = session.uiMessages.find((m) => m.id === messageId)
    if (!msg) return
    if (!msg.tools) msg.tools = []
    const idx = msg.tools.findIndex((t) => t.id === tool.id)
    if (idx >= 0) msg.tools[idx] = tool
    else msg.tools.push(tool)
    this.touch(session)
  }

  clearSession(session: Session): void {
    session.uiMessages = []
    session.agentHistory = []
    session.filesWritten = []
    session.title = '新对话'
    this.touch(session)
  }
}
