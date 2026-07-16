/**
 * 多会话管理：维护会话列表、UI 消息时间线、Agent 模型上下文。
 * 持久化到 .deepagent/sessions.json，服务重启后可恢复。
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
  createdAt: number
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
  activeId: string | null
  sessions: Session[]
}

const CONFIG_DIR = path.resolve(process.cwd(), '.deepagent')
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
    return { activeId, sessions }
  } catch (err) {
    console.warn('[SessionStore] 读取持久化失败，将使用空状态：', err)
    return null
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>()
  private activeId: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private persistEnabled: boolean

  constructor(options: { persist?: boolean } = {}) {
    this.persistEnabled = options.persist !== false
    const loaded = this.persistEnabled ? loadRaw() : null
    if (loaded) {
      for (const s of loaded.sessions) {
        this.sessions.set(s.id, s)
      }
      this.activeId = loaded.activeId
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
        activeId: this.activeId,
        sessions: [...this.sessions.values()],
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      console.error('[SessionStore] 持久化失败：', err)
    }
  }

  create(title = '新对话'): Session {
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      uiMessages: [],
      agentHistory: [],
      filesWritten: [],
    }
    this.sessions.set(session.id, session)
    this.activeId = session.id
    this.scheduleSave()
    return session
  }

  ensureActive(): Session {
    if (this.activeId) {
      const s = this.sessions.get(this.activeId)
      if (s) return s
    }
    return this.create()
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  getActiveId(): string | null {
    return this.activeId
  }

  setActive(id: string): Session | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    this.activeId = id
    this.scheduleSave()
    return s
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
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

  delete(id: string): boolean {
    const ok = this.sessions.delete(id)
    if (this.activeId === id) {
      this.activeId = this.sessions.size
        ? [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
            ?.id ?? null
        : null
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
