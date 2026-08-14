/**
 * deepCodex Web UI
 * - 多会话历史
 * - SSE 流式 + 工具调用时间线
 * - HITL 弹窗确认
 */

const $ = (sel, root = document) => root.querySelector(sel)

const TOKEN_KEY = 'deepcodex_access_token'

const els = {
  app: $('.app'),
  authGate: $('#authGate'),
  authForm: $('#authForm'),
  authTokenInput: $('#authTokenInput'),
  authError: $('#authError'),
  btnAuthSubmit: $('#btnAuthSubmit'),
  btnLogout: $('#btnLogout'),
  skillList: $('#skillList'),
  fileList: $('#fileList'),
  sessionList: $('#sessionList'),
  workspaceList: $('#workspaceList'),
  outputPathText: $('#outputPathText'),
  modelPill: $('#modelPill'),
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  sessionTitle: $('#sessionTitle'),
  emptyState: $('#emptyState'),
  messages: $('#messages'),
  chatScroll: $('#chatScroll'),
  composer: $('#composer'),
  composerBox: $('#composerBox'),
  input: $('#input'),
  imageInput: $('#imageInput'),
  btnUploadImage: $('#btnUploadImage'),
  ocrPreview: $('#ocrPreview'),
  ocrThumbnail: $('#ocrThumbnail'),
  ocrFilename: $('#ocrFilename'),
  ocrStatus: $('#ocrStatus'),
  ocrText: $('#ocrText'),
  btnRemoveImage: $('#btnRemoveImage'),
  btnSend: $('#btnSend'),
  btnClear: $('#btnClear'),
  btnNewChat: $('#btnNewChat'),
  btnToggleSidebar: $('#btnToggleSidebar'),
  btnAddWorkspace: $('#btnAddWorkspace'),
  suggestions: $('#suggestions'),
  hitlModal: $('#hitlModal'),
  hitlBadge: $('#hitlBadge'),
  hitlDesc: $('#hitlDesc'),
  hitlOperation: $('#hitlOperation'),
  hitlDetail: $('#hitlDetail'),
  btnHitlApprove: $('#btnHitlApprove'),
  btnHitlReject: $('#btnHitlReject'),
  workspaceModal: $('#workspaceModal'),
  workspaceBackdrop: $('#workspaceBackdrop'),
  wsModalTitle: $('#wsModalTitle'),
  wsNameInput: $('#wsNameInput'),
  wsPathInput: $('#wsPathInput'),
  btnWsCancel: $('#btnWsCancel'),
  btnWsSave: $('#btnWsSave'),
  messageModal: $('#messageModal'),
  messageBackdrop: $('#messageBackdrop'),
  messageTitle: $('#messageTitle'),
  messageText: $('#messageText'),
  btnMessageOk: $('#btnMessageOk'),
}

const MEDIA_UPLOAD_RULES = {
  maxFiles: 1,
  maxBytes: 20 * 1024 * 1024,
  extensions: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  hint: '支持 JPG/JPEG、PNG、WebP、PDF；每次只能上传 1 个文件；单个文件不超过 20 MB。',
}

const state = {
  busy: false,
  sessionId: null,
  sessions: [],
  /** messageId -> { row, contentEl, toolsEl, metaEl, tools: Map } */
  live: new Map(),
  hitlQueue: [],
  hitlCurrent: null,
  workspaces: [],
  activeWorkspaceId: null,
  /** null = 新增；string = 编辑该 id */
  editingWorkspaceId: null,
  accessToken: sessionStorage.getItem(TOKEN_KEY) || '',
  authRequired: false,
  publicMode: false,
  workspacesLocked: false,
  /** 当前待发送的多模态附件；原始 File 只保存在本次页面内存中。 */
  ocrAttachment: null,
  ocrBusy: false,
}

/* ── Auth / API ─────────────────────────────────────────── */
function getAccessToken() {
  return state.accessToken || sessionStorage.getItem(TOKEN_KEY) || ''
}

function setAccessToken(token) {
  state.accessToken = token || ''
  if (token) sessionStorage.setItem(TOKEN_KEY, token)
  else sessionStorage.removeItem(TOKEN_KEY)
}

function authHeaders(extra = {}) {
  const headers = { ...extra }
  const token = getAccessToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['X-Access-Token'] = token
  }
  return headers
}

async function apiFetch(url, options = {}) {
  const opts = { ...options }
  const baseHeaders =
    opts.body && !(opts.body instanceof FormData) && !(opts.headers && opts.headers['Content-Type'])
      ? { 'Content-Type': 'application/json' }
      : {}
  opts.headers = authHeaders({ ...baseHeaders, ...(opts.headers || {}) })
  const res = await fetch(url, opts)
  if (res.status === 401 && state.authRequired) {
    showAuthGate('口令无效或已过期，请重新输入')
  }
  return res
}

function showAuthGate(errorMsg) {
  document.body.classList.add('auth-locked')
  if (els.app) els.app.hidden = true
  if (els.authGate) els.authGate.hidden = false
  if (els.authError) {
    if (errorMsg) {
      els.authError.hidden = false
      els.authError.textContent = errorMsg
    } else {
      els.authError.hidden = true
      els.authError.textContent = ''
    }
  }
  els.authTokenInput?.focus()
}

function hideAuthGate() {
  document.body.classList.remove('auth-locked')
  if (els.authGate) els.authGate.hidden = true
  if (els.app) els.app.hidden = false
  if (els.btnLogout) els.btnLogout.hidden = !state.authRequired
}

async function checkAuthStatus() {
  const res = await fetch('/api/auth/status', {
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error('无法连接服务')
  const data = await res.json()
  state.authRequired = Boolean(data.authRequired)
  state.publicMode = Boolean(data.publicMode)
  return data
}

async function ensureAuthorized() {
  const status = await checkAuthStatus()
  if (!status.authRequired) {
    hideAuthGate()
    return true
  }
  if (status.authorized && getAccessToken()) {
    hideAuthGate()
    return true
  }
  // 有缓存口令时先验证 meta
  if (getAccessToken()) {
    const probe = await apiFetch('/api/meta')
    if (probe.ok) {
      hideAuthGate()
      return true
    }
    setAccessToken('')
  }
  showAuthGate()
  return new Promise((resolve) => {
    const onSubmit = async (e) => {
      e.preventDefault()
      const token = (els.authTokenInput?.value || '').trim()
      if (!token) {
        showAuthGate('请输入访问口令')
        return
      }
      setAccessToken(token)
      els.btnAuthSubmit.disabled = true
      try {
        const res = await apiFetch('/api/meta')
        if (!res.ok) {
          setAccessToken('')
          showAuthGate('口令不正确，请重试')
          return
        }
        els.authForm?.removeEventListener('submit', onSubmit)
        hideAuthGate()
        resolve(true)
      } catch {
        setAccessToken('')
        showAuthGate('网络错误，请重试')
      } finally {
        els.btnAuthSubmit.disabled = false
      }
    }
    els.authForm?.addEventListener('submit', onSubmit)
  })
}

els.btnLogout?.addEventListener('click', () => {
  setAccessToken('')
  showAuthGate()
  location.reload()
})

const STATUS_MAP = {
  ready: '就绪',
  thinking: '思考中…',
  streaming: '生成中…',
  writing_files: '处理文件…',
  waiting_hitl: '等待确认…',
  done: '就绪',
  error: '出错',
}

const TOOL_LABELS = {
  skill_scan: 'Skill',
  llm_generate: 'LLM',
  write_file: 'Write',
  hitl_check: 'HITL',
}

const TOOL_STATUS_TEXT = {
  pending: 'pending',
  running: 'running',
  waiting_approval: 'waiting',
  success: 'done',
  error: 'error',
  cancelled: 'cancelled',
}

/* ── utils ──────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function showMessageModal(message, title = '附件上传失败') {
  els.messageTitle.textContent = title
  els.messageText.textContent = message || MEDIA_UPLOAD_RULES.hint
  els.messageModal.hidden = false
  els.btnMessageOk.focus()
}

function hideMessageModal() {
  els.messageModal.hidden = true
  els.btnUploadImage?.focus()
}

function canSendMessage() {
  const hasText = Boolean(els.input.value.trim())
  const hasOcrText = Boolean(state.ocrAttachment && els.ocrText.value.trim())
  return !state.busy && !state.ocrBusy && (hasText || hasOcrText)
}

function setStatus(key) {
  els.statusText.textContent = STATUS_MAP[key] ?? key
  const busy =
    key === 'thinking' ||
    key === 'streaming' ||
    key === 'writing_files' ||
    key === 'waiting_hitl'
  els.statusDot.classList.toggle('busy', busy)
  els.statusDot.classList.toggle('error', key === 'error')
}

function setBusy(busy) {
  state.busy = busy
  els.btnSend.disabled = !canSendMessage()
  els.input.disabled = busy
  els.btnUploadImage.disabled = busy || state.ocrBusy
  els.btnRemoveImage.disabled = busy
  els.ocrText.disabled = busy || state.ocrBusy
}

function scrollToBottom(force = false) {
  const el = els.chatScroll
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  if (force || nearBottom) el.scrollTop = el.scrollHeight
}

/* ── Markdown ───────────────────────────────────────────── */
function renderMarkdown(src) {
  if (!src) return ''
  try {
    if (typeof marked !== 'undefined' && marked.parse) {
      return marked.parse(src, { breaks: true })
    }
  } catch { /* CDN 未加载时静默降级 */ }
  // 降级：纯文本 + 换行
  return escapeHtml(src).replace(/\n/g, '<br />')
}
/**
 * 流式 Markdown 渲染节流：避免每个 token 都整段 re-parse 导致卡顿。
 * 默认约 80ms 刷新一次，结束时 flush 保证最终一致。
 */
function createStreamRenderer(contentEl, intervalMs = 80) {
  let full = ''
  let timer = null
  let dirty = false

  function paint() {
    dirty = false
    timer = null
    contentEl.innerHTML = renderMarkdown(full)
    scrollToBottom()
  }

  function schedule() {
    dirty = true
    if (timer != null) return
    timer = setTimeout(paint, intervalMs)
  }

  return {
    append(delta) {
      if (!delta) return
      full += delta
      schedule()
    },
    setFull(text) {
      full = text || ''
      schedule()
    },
    getFull() {
      return full
    },
    flush() {
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
      contentEl.innerHTML = renderMarkdown(full)
      contentEl.classList.remove('streaming')
      scrollToBottom()
      return full
    },
  }
}

/* ── Tool cards ─────────────────────────────────────────── */
function toolIcon(name) {
  return TOOL_LABELS[name] || name.slice(0, 2).toUpperCase()
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function renderToolCard(tool) {
  const status = tool.status || 'pending'
  const open = status === 'waiting_approval' || status === 'error'
  return `
    <div class="tool-card ${open ? 'open' : ''}" data-tool-id="${escapeHtml(tool.id)}" data-tool-name="${escapeHtml(tool.name)}" data-status="${escapeHtml(status)}">
      <button type="button" class="tool-head" data-tool-toggle>
        <span class="tool-icon">${escapeHtml(toolIcon(tool.name))}</span>
        <span class="tool-main">
          <div class="tool-title">${escapeHtml(tool.title || tool.name)}</div>
          <div class="tool-sub">${escapeHtml(tool.name)}</div>
        </span>
        <span class="tool-status">${escapeHtml(TOOL_STATUS_TEXT[status] || status)}</span>
        <span class="tool-chevron">›</span>
      </button>
      <div class="tool-body">
        ${
          tool.input
            ? `<div class="tool-section"><div class="label">Input</div><pre>${escapeHtml(prettyJson(tool.input))}</pre></div>`
            : ''
        }
        ${
          tool.output
            ? `<div class="tool-section"><div class="label">Output</div><pre>${escapeHtml(prettyJson(tool.output))}</pre></div>`
            : ''
        }
      </div>
    </div>
  `
}

function mountToolCard(toolsEl, tool) {
  const existing = toolsEl.querySelector(`[data-tool-id="${CSS.escape(tool.id)}"]`)
  const html = renderToolCard(tool)
  if (existing) {
    const wasOpen = existing.classList.contains('open')
    existing.outerHTML = html
    const next = toolsEl.querySelector(`[data-tool-id="${CSS.escape(tool.id)}"]`)
    if (wasOpen && next && tool.status !== 'waiting_approval') next.classList.add('open')
  } else {
    toolsEl.insertAdjacentHTML('beforeend', html)
  }

  // 同步执行步骤数量，方便折叠状态下快速判断智能体做了多少工作。
  const panel = toolsEl.closest('.execution-panel')
  const count = toolsEl.querySelectorAll('.tool-card').length
  const countEl = panel?.querySelector('[data-execution-count]')
  if (countEl) countEl.textContent = `${count} 步`
  if (panel && (tool.status === 'running' || tool.status === 'waiting_approval' || tool.status === 'error')) {
    panel.open = true
  }
}

els.messages.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tool-toggle]')
  if (!btn) return
  const card = btn.closest('.tool-card')
  card?.classList.toggle('open')
})

/* ── Messages ───────────────────────────────────────────── */
function showMessagesView(has) {
  els.emptyState.hidden = has
  els.messages.hidden = !has
}

function clearMessagesDom() {
  els.messages.innerHTML = ''
  state.live.clear()
}

function appendUserMessage(text, attachments = []) {
  showMessagesView(true)
  const row = document.createElement('div')
  row.className = 'msg user'
  row.innerHTML = `
    <div class="msg-avatar"><img src="/assets/avatars/user-avatar-v3.png" alt="用户头像" /></div>
    <div class="msg-body">
      <div class="msg-role">You</div>
      <div class="msg-content"></div>
    </div>
  `
  row.querySelector('.msg-content').textContent = text
  const attachment = attachments[0]
  if (attachment) {
    const badge = document.createElement('div')
    badge.className = 'user-attachment'
    const label = attachment.type === 'pdf'
      ? 'PDF 解析'
      : attachment.mode === 'ocr' || attachment.type === 'ocr'
        ? '图片 OCR'
        : '图片理解'
    badge.textContent = `${label} · ${attachment.filename}`
    row.querySelector('.msg-body').appendChild(badge)
  }
  els.messages.appendChild(row)
  scrollToBottom(true)
}

function appendAssistantShell(messageId, { streaming = true } = {}) {
  showMessagesView(true)
  const row = document.createElement('div')
  row.className = 'msg assistant'
  row.dataset.messageId = messageId || ''
  row.innerHTML = `
    <div class="msg-avatar"><img src="/assets/avatars/deepcodex-avatar.png" alt="deepCodex 头像" /></div>
    <div class="msg-body">
      <div class="msg-role"><span>deepCodex</span><span class="assistant-state">${streaming ? '正在处理' : '已完成'}</span></div>
      <section class="result-panel">
        <div class="result-label">结果</div>
        <div class="msg-content md ${streaming ? 'streaming' : ''}"></div>
      </section>
      <div class="msg-meta" hidden></div>
      <details class="execution-panel" ${streaming ? 'open' : ''}>
        <summary>
          <span>执行过程</span>
          <span class="execution-count" data-execution-count>0 步</span>
        </summary>
        <div class="tool-timeline"></div>
      </details>
    </div>
  `
  els.messages.appendChild(row)
  const handle = {
    row,
    contentEl: row.querySelector('.msg-content'),
    toolsEl: row.querySelector('.tool-timeline'),
    executionEl: row.querySelector('.execution-panel'),
    stateEl: row.querySelector('.assistant-state'),
    metaEl: row.querySelector('.msg-meta'),
    tools: new Map(),
  }
  if (messageId) state.live.set(messageId, handle)
  scrollToBottom(true)
  return handle
}

function appendError(message) {
  showMessagesView(true)
  const row = document.createElement('div')
  row.className = 'msg assistant'
  row.innerHTML = `
    <div class="msg-avatar">!</div>
    <div class="msg-body">
      <div class="msg-role">System</div>
      <div class="msg-error"></div>
    </div>
  `
  row.querySelector('.msg-error').textContent = message
  els.messages.appendChild(row)
  scrollToBottom(true)
}

function renderHistoryMessages(messages) {
  clearMessagesDom()
  if (!messages?.length) {
    showMessagesView(false)
    return
  }
  showMessagesView(true)
  for (const msg of messages) {
    if (msg.role === 'user') {
      appendUserMessage(msg.content, msg.attachments || [])
    } else if (msg.role === 'assistant') {
      const handle = appendAssistantShell(msg.id, { streaming: false })
      if (msg.tools?.length) {
        for (const tool of msg.tools) {
          handle.tools.set(tool.id, tool)
          mountToolCard(handle.toolsEl, tool)
        }
      }
      handle.contentEl.innerHTML = renderMarkdown(msg.content || '')
      if (msg.filesWritten?.length) {
        handle.metaEl.hidden = false
        handle.metaEl.innerHTML = msg.filesWritten
          .map((f) => `<span class="chip">📄 ${escapeHtml(f)}</span>`)
          .join('')
      }
    } else if (msg.role === 'system') {
      appendError(msg.content)
    }
  }
  scrollToBottom(true)
}

/* ── HITL modal ─────────────────────────────────────────── */
function showHitlModal(req) {
  state.hitlCurrent = req
  els.hitlBadge.textContent = (req.riskLevel || 'medium').toUpperCase()
  els.hitlBadge.classList.toggle('high', req.riskLevel === 'high')
  els.hitlDesc.textContent =
    req.type === 'file_write'
      ? '智能体准备写入文件，请确认路径与内容预览。'
      : req.type === 'high_risk'
        ? '检测到高风险指令，确认后才会继续执行。'
        : '智能体准备执行以下操作，请确认是否继续。'
  els.hitlOperation.textContent = req.operation || '未知操作'
  if (req.detail) {
    els.hitlDetail.hidden = false
    els.hitlDetail.textContent =
      typeof req.detail === 'string' ? req.detail : prettyJson(req.detail)
  } else {
    els.hitlDetail.hidden = true
    els.hitlDetail.textContent = ''
  }
  els.hitlModal.hidden = false
  setStatus('waiting_hitl')
  els.btnHitlApprove.focus()
}

function hideHitlModal() {
  els.hitlModal.hidden = true
  state.hitlCurrent = null
  // 处理队列中下一个
  if (state.hitlQueue.length) {
    showHitlModal(state.hitlQueue.shift())
  }
}

function enqueueHitl(req) {
  if (state.hitlCurrent) {
    state.hitlQueue.push(req)
  } else {
    showHitlModal(req)
  }
}

async function respondHitl(approved) {
  const current = state.hitlCurrent
  if (!current) return
  const id = current.id
  hideHitlModal()
  try {
    const res = await apiFetch('/api/hitl', {
      method: 'POST',
      body: JSON.stringify({ id, approved }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.error || `HITL 响应失败 ${res.status}`)
    }
  } catch (err) {
    console.error(err)
    appendError(err.message || String(err))
  }
}

els.btnHitlApprove.addEventListener('click', () => respondHitl(true))
els.btnHitlReject.addEventListener('click', () => respondHitl(false))
els.hitlModal.addEventListener('click', (e) => {
  // 点击背景不自动拒绝，避免误触；Esc 拒绝
})
document.addEventListener('keydown', (e) => {
  if (els.hitlModal.hidden) return
  if (e.key === 'Escape') {
    e.preventDefault()
    respondHitl(false)
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    respondHitl(true)
  }
})

/* ── Sessions API ───────────────────────────────────────── */
async function loadSessions() {
  const res = await apiFetch('/api/sessions')
  if (!res.ok) throw new Error('无法加载会话列表')
  const data = await res.json()
  state.sessions = data.sessions || []
  if (!state.sessionId) state.sessionId = data.activeSessionId
  renderSessionList()
}

function renderSessionList() {
  if (!state.sessions.length) {
    els.sessionList.innerHTML = `<li class="session-item muted">暂无会话</li>`
    return
  }
  els.sessionList.innerHTML = state.sessions
    .map((s) => {
      const active = s.id === state.sessionId ? 'active' : ''
      return `
        <li>
          <button type="button" class="session-item ${active}" data-session-id="${escapeHtml(s.id)}">
            <div>
              <div class="session-title">${escapeHtml(s.title || '新对话')}</div>
              <div class="session-meta">${escapeHtml(formatTime(s.updatedAt))} · ${s.messageCount || 0} 条</div>
            </div>
            <span class="session-del" data-del-session="${escapeHtml(s.id)}" title="删除">×</span>
          </button>
        </li>
      `
    })
    .join('')
}

els.sessionList.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-session]')
  if (del) {
    e.preventDefault()
    e.stopPropagation()
    const id = del.getAttribute('data-del-session')
    if (!id || state.busy) return
    if (!confirm('删除该会话？')) return
    await deleteSession(id)
    return
  }
  const item = e.target.closest('[data-session-id]')
  if (!item || state.busy) return
  const id = item.getAttribute('data-session-id')
  if (id && id !== state.sessionId) await openSession(id)
})

async function openSession(id) {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) {
    appendError('会话不存在或无法打开')
    return
  }
  const data = await res.json()
  state.sessionId = data.id
  els.sessionTitle.textContent = data.title || '新对话'
  renderHistoryMessages(data.messages || [])
  await loadSessions()
  await loadFiles()
}

async function createSession() {
  if (state.busy) return
  const res = await apiFetch('/api/sessions', { method: 'POST' })
  if (!res.ok) throw new Error('创建会话失败')
  const data = await res.json()
  state.sessionId = data.id
  els.sessionTitle.textContent = data.title || '新对话'
  clearMessagesDom()
  showMessagesView(false)
  await loadSessions()
  els.input.focus()
}

async function deleteSession(id) {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) return
  const data = await res.json()
  state.sessions = data.sessions || []
  const nextId = data.activeSessionId
  if (nextId) {
    await openSession(nextId)
  } else {
    await createSession()
  }
}

async function clearCurrentSession() {
  if (!state.sessionId || state.busy) return
  const res = await apiFetch(
    `/api/sessions/${encodeURIComponent(state.sessionId)}/clear`,
    { method: 'POST' },
  )
  if (!res.ok) return
  const data = await res.json()
  els.sessionTitle.textContent = data.session?.title || '新对话'
  clearMessagesDom()
  showMessagesView(false)
  await loadSessions()
  await loadFiles()
  setStatus('ready')
}

/* ── Meta / files ───────────────────────────────────────── */
async function loadMeta() {
  try {
    const res = await apiFetch('/api/meta')
    if (!res.ok) throw new Error(`meta ${res.status}`)
    const data = await res.json()
    els.modelPill.textContent = data.model || 'deepseek-v4-flash'
    if (data.multimodal) {
      const available = [
        data.multimodal.openai?.configured ? `OpenAI ${data.multimodal.openai.model}` : '',
        data.multimodal.ollama?.enabled ? `Ollama ${data.multimodal.ollama.model}` : '',
        '本地 OCR/PDF',
      ].filter(Boolean)
      // 不占用额外界面空间，通过上传按钮提示当前实际降级顺序。
      els.btnUploadImage.title = `上传图片或 PDF（解析顺序：${available.join(' → ')}）`
    }
    state.publicMode = Boolean(data.publicMode)
    state.workspacesLocked = Boolean(data.workspacesLocked || data.publicMode)
    applyWorkspaceLockUi()
    if (Array.isArray(data.skills) && data.skills.length) {
      els.skillList.innerHTML = data.skills
        .map(
          (s) => `
          <li class="skill-item" title="${escapeHtml(s.description || '')}">
            <strong>${escapeHtml(s.name)}</strong>
            <span>${escapeHtml((s.description || '').slice(0, 48))}${(s.description || '').length > 48 ? '…' : ''}</span>
          </li>`,
        )
        .join('')
    } else {
      els.skillList.innerHTML = `<li class="skill-item muted">未加载技能</li>`
    }
    if (data.activeSessionId && !state.sessionId) {
      state.sessionId = data.activeSessionId
    }
  } catch (err) {
    console.error(err)
    els.skillList.innerHTML = `<li class="skill-item muted">无法加载技能列表</li>`
  }
}

function applyWorkspaceLockUi() {
  if (!els.btnAddWorkspace) return
  if (state.workspacesLocked) {
    els.btnAddWorkspace.hidden = true
    els.btnAddWorkspace.disabled = true
  } else {
    els.btnAddWorkspace.hidden = false
    els.btnAddWorkspace.disabled = false
  }
}

async function loadFiles() {
  try {
    const res = await apiFetch('/api/files')
    if (!res.ok) return
    const data = await res.json()
    if (data.outputPath) {
      els.outputPathText.textContent = data.outputPath
    }
    const files = data.files || []
    if (!files.length) {
      els.fileList.innerHTML = `<li class="file-item muted">暂无输出文件</li>`
      return
    }
    const base = data.outputPath || ''
    els.fileList.innerHTML = files
      .map((f) => {
        const full = base ? `${base}\\${f}`.replace(/\\\\/g, '\\') : f
        return `<li class="file-item" title="${escapeHtml(full)}">${escapeHtml(f)}</li>`
      })
      .join('')
  } catch {
    /* ignore */
  }
}

/* ── Workspaces（本地输出目录） ─────────────────────────── */
async function loadWorkspaces() {
  try {
    const res = await apiFetch('/api/workspaces')
    if (!res.ok) throw new Error('无法加载工作区')
    const data = await res.json()
    state.workspaces = data.folders || []
    state.activeWorkspaceId = data.activeId
    if (data.locked) state.workspacesLocked = true
    applyWorkspaceLockUi()
    if (data.active?.path) els.outputPathText.textContent = data.active.path
    renderWorkspaceList()
  } catch (err) {
    console.error(err)
    els.workspaceList.innerHTML = `<li class="file-item muted">无法加载目录列表</li>`
  }
}

function renderWorkspaceList() {
  if (!state.workspaces.length) {
    els.workspaceList.innerHTML = `<li class="file-item muted">暂无目录</li>`
    return
  }
  const locked = state.workspacesLocked
  els.workspaceList.innerHTML = state.workspaces
    .map((w) => {
      const active = w.id === state.activeWorkspaceId ? 'active' : ''
      const actions = locked
        ? ''
        : `<div class="workspace-actions">
            <button type="button" data-edit-ws="${escapeHtml(w.id)}" title="编辑">✎</button>
            <button type="button" class="danger" data-del-ws="${escapeHtml(w.id)}" title="删除">×</button>
          </div>`
      return `
        <li class="workspace-item ${active}" data-ws-id="${escapeHtml(w.id)}">
          <button type="button" class="ws-main" data-activate-ws="${escapeHtml(w.id)}" ${locked ? 'disabled' : ''}>
            <div class="ws-name">
              <span class="ws-folder-icon" aria-hidden="true"></span>
              <span>${escapeHtml(w.name)}${locked ? '（已锁定）' : ''}</span>
              ${active ? '<span class="ws-active-label">使用中</span>' : ''}
            </div>
            <div class="ws-path">${escapeHtml(w.path)}</div>
          </button>
          ${actions}
        </li>
      `
    })
    .join('')
}

function openWorkspaceModal(mode, folder) {
  state.editingWorkspaceId = mode === 'edit' && folder ? folder.id : null
  els.wsModalTitle.textContent = state.editingWorkspaceId
    ? '编辑输出目录'
    : '添加本地输出目录'
  els.wsNameInput.value = folder?.name || ''
  els.wsPathInput.value = folder?.path || ''
  els.workspaceModal.hidden = false
  els.wsPathInput.focus()
}

/** 路径变更时，名称若为空则自动用最后一级文件夹名 */
els.wsPathInput?.addEventListener('blur', () => {
  if (els.wsNameInput.value.trim()) return
  const p = els.wsPathInput.value.trim().replace(/[/\\]+$/, '')
  if (!p) return
  const parts = p.split(/[/\\]/).filter(Boolean)
  const base = parts[parts.length - 1]
  if (base) els.wsNameInput.placeholder = `留空将使用：${base}`
})

function closeWorkspaceModal() {
  els.workspaceModal.hidden = true
  state.editingWorkspaceId = null
  els.wsNameInput.value = ''
  els.wsPathInput.value = ''
}

async function saveWorkspace() {
  if (state.workspacesLocked) {
    alert('公网模式下输出目录已锁定')
    return
  }
  const name = els.wsNameInput.value.trim()
  const folderPath = els.wsPathInput.value.trim()
  if (!folderPath) {
    alert('请填写文件夹绝对路径')
    els.wsPathInput.focus()
    return
  }

  try {
    let res
    if (state.editingWorkspaceId) {
      res = await apiFetch(
        `/api/workspaces/${encodeURIComponent(state.editingWorkspaceId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ name: name || undefined, path: folderPath }),
        },
      )
    } else {
      res = await apiFetch('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, path: folderPath }),
      })
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `保存失败 ${res.status}`)

    closeWorkspaceModal()
    state.workspaces = data.workspace?.folders || []
    state.activeWorkspaceId = data.workspace?.activeId
    if (data.workspace?.active?.path) {
      els.outputPathText.textContent = data.workspace.active.path
    } else if (data.folder?.path) {
      els.outputPathText.textContent = data.folder.path
    }
    renderWorkspaceList()
    await loadFiles()
  } catch (err) {
    alert(err.message || String(err))
  }
}

els.btnAddWorkspace?.addEventListener('click', () => openWorkspaceModal('add'))
els.btnWsCancel?.addEventListener('click', closeWorkspaceModal)
els.btnWsSave?.addEventListener('click', saveWorkspace)
els.workspaceBackdrop?.addEventListener('click', closeWorkspaceModal)

els.workspaceList?.addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-ws]')
  if (edit) {
    e.preventDefault()
    e.stopPropagation()
    const id = edit.getAttribute('data-edit-ws')
    const folder = state.workspaces.find((w) => w.id === id)
    if (folder) openWorkspaceModal('edit', folder)
    return
  }

  const del = e.target.closest('[data-del-ws]')
  if (del) {
    e.preventDefault()
    e.stopPropagation()
    const id = del.getAttribute('data-del-ws')
    if (!id) return
    if (!confirm('删除该输出目录配置？（不会删除磁盘上的文件）')) return
    try {
      const res = await apiFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '删除失败')
      state.workspaces = data.workspace?.folders || []
      state.activeWorkspaceId = data.workspace?.activeId
      if (data.workspace?.active?.path) {
        els.outputPathText.textContent = data.workspace.active.path
      }
      renderWorkspaceList()
      await loadFiles()
    } catch (err) {
      alert(err.message || String(err))
    }
    return
  }

  const activate = e.target.closest('[data-activate-ws]')
  if (activate) {
    if (state.workspacesLocked) return
    const id = activate.getAttribute('data-activate-ws')
    if (!id || id === state.activeWorkspaceId) return
    try {
      const res = await apiFetch(
        `/api/workspaces/${encodeURIComponent(id)}/activate`,
        { method: 'POST' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '切换失败')
      state.workspaces = data.workspace?.folders || []
      state.activeWorkspaceId = data.workspace?.activeId
      if (data.folder?.path) els.outputPathText.textContent = data.folder.path
      renderWorkspaceList()
      await loadFiles()
    } catch (err) {
      alert(err.message || String(err))
    }
  }
})

/* ── Multimodal attachment ─────────────────────────────── */
function clearOcrAttachment() {
  if (state.ocrAttachment?.previewUrl) URL.revokeObjectURL(state.ocrAttachment.previewUrl)
  state.ocrAttachment = null
  state.ocrBusy = false
  els.imageInput.value = ''
  els.ocrPreview.hidden = true
  els.ocrThumbnail.removeAttribute('src')
  els.ocrFilename.textContent = '—'
  els.ocrStatus.textContent = '准备解析'
  els.ocrStatus.classList.remove('ocr-error')
  els.ocrText.value = ''
  autoResize()
}

function validateSelectedMedia(file) {
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : ''
  if (!MEDIA_UPLOAD_RULES.extensions.includes(extension) || !MEDIA_UPLOAD_RULES.mimeTypes.includes(file.type)) {
    return `“${file.name || '未命名文件'}”格式不正确。${MEDIA_UPLOAD_RULES.hint}`
  }
  if (file.size > MEDIA_UPLOAD_RULES.maxBytes) {
    return `“${file.name}”超过 20 MB。${MEDIA_UPLOAD_RULES.hint}`
  }
  if (!file.size) return `“${file.name}”内容为空。${MEDIA_UPLOAD_RULES.hint}`
  return ''
}

async function uploadMediaForAnalysis(file) {
  const validationError = validateSelectedMedia(file)
  if (validationError) {
    showMessageModal(validationError)
    return
  }

  clearOcrAttachment()
  const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : ''
  const pending = { file, previewUrl, result: null }
  state.ocrAttachment = pending
  state.ocrBusy = true
  els.ocrPreview.hidden = false
  if (pending.previewUrl) {
    els.ocrThumbnail.src = pending.previewUrl
    els.ocrThumbnail.alt = '待解析图片预览'
  } else {
    els.ocrThumbnail.removeAttribute('src')
    els.ocrThumbnail.alt = 'PDF 文件'
  }
  els.ocrFilename.textContent = file.name
  els.ocrStatus.textContent = file.type === 'application/pdf' ? '正在解析 PDF…' : '正在理解图片…'
  els.ocrText.value = ''
  setBusy(state.busy)

  try {
    const form = new FormData()
    form.append('image', file, file.name)
    const res = await apiFetch('/api/media/analyze', { method: 'POST', body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `附件解析失败（${res.status}）`)
    // 用户可能在识别期间移除了图片，过期响应不能重新挂回输入框。
    if (state.ocrAttachment !== pending) return
    pending.result = data
    els.ocrText.value = data.analysis || ''
    if (data.analysis?.trim()) {
      const mode = data.mode === 'hybrid' ? '视觉 + OCR' : data.mode === 'vision' ? '视觉理解' : data.mode === 'local-pdf' ? '本地 PDF' : '本地 OCR'
      const provider = data.provider ? ` · ${data.provider}${data.model ? `/${data.model}` : ''}` : ''
      const confidence = data.confidence == null ? '' : ` · OCR 置信度 ${Math.round(Number(data.confidence))}%`
      els.ocrStatus.textContent = `解析完成 · ${mode}${provider}${confidence}`
      if (data.warning) showMessageModal(data.warning, '附件解析提示')
    } else {
      els.ocrStatus.textContent = '没有获得可用的解析结果'
      els.ocrStatus.classList.add('ocr-error')
      showMessageModal('附件上传成功，但没有获得可用的解析结果。', '解析失败')
    }
  } catch (error) {
    if (state.ocrAttachment !== pending) return
    els.ocrStatus.textContent = '识别失败，请重试'
    els.ocrStatus.classList.add('ocr-error')
    showMessageModal(error.message || String(error))
  } finally {
    if (state.ocrAttachment === pending) {
      state.ocrBusy = false
      setBusy(state.busy)
      autoResize()
    }
  }
}

function handleMediaFiles(files) {
  const selected = Array.from(files || [])
  if (!selected.length) return
  if (selected.length > MEDIA_UPLOAD_RULES.maxFiles) {
    showMessageModal(`当前选择了 ${selected.length} 个文件，一次只能上传 1 个。${MEDIA_UPLOAD_RULES.hint}`)
    return
  }
  void uploadMediaForAnalysis(selected[0])
}

els.btnUploadImage?.addEventListener('click', () => els.imageInput.click())
els.imageInput?.addEventListener('change', () => handleMediaFiles(els.imageInput.files))
els.btnRemoveImage?.addEventListener('click', clearOcrAttachment)
els.ocrText?.addEventListener('input', autoResize)
els.composerBox?.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  els.composerBox.classList.add('dragging')
})
els.composerBox?.addEventListener('dragleave', () => els.composerBox.classList.remove('dragging'))
els.composerBox?.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length) return
  event.preventDefault()
  els.composerBox.classList.remove('dragging')
  handleMediaFiles(event.dataTransfer.files)
})
document.addEventListener('paste', (event) => {
  if (state.busy) return
  const media = Array.from(event.clipboardData?.files || []).filter((file) => MEDIA_UPLOAD_RULES.mimeTypes.includes(file.type))
  if (!media.length) return
  event.preventDefault()
  handleMediaFiles(media)
})

els.btnMessageOk?.addEventListener('click', hideMessageModal)
els.messageBackdrop?.addEventListener('click', hideMessageModal)
document.addEventListener('keydown', (event) => {
  if (els.messageModal?.hidden || event.key !== 'Escape') return
  event.preventDefault()
  hideMessageModal()
})

/* ── Chat SSE ───────────────────────────────────────────── */
async function sendMessage(raw) {
  const message = (raw ?? els.input.value).trim()
  const ocrText = els.ocrText.value.trim()
  const attachment = state.ocrAttachment?.result && ocrText
    ? {
        type: state.ocrAttachment.result.type,
        filename: state.ocrAttachment.result.filename,
        mimeType: state.ocrAttachment.result.mimeType,
        analysis: ocrText,
        ocrText: state.ocrAttachment.result.ocrText,
        confidence: state.ocrAttachment.result.confidence,
        mode: state.ocrAttachment.result.mode,
        provider: state.ocrAttachment.result.provider,
        model: state.ocrAttachment.result.model,
        warning: state.ocrAttachment.result.warning,
      }
    : null
  if ((!message && !attachment) || state.busy || state.ocrBusy) return
  if (!state.sessionId) await createSession()

  els.input.value = ''
  clearOcrAttachment()
  autoResize()
  els.btnSend.disabled = true

  const displayMessage = message || '请理解并处理附件内容；如果意图不明确，请先向我确认。'
  appendUserMessage(displayMessage, attachment ? [attachment] : [])
  // 临时 shell，等服务端 messageId
  let assistant = appendAssistantShell('pending', { streaming: true })
  const streamView = createStreamRenderer(assistant.contentEl, 80)
  let messageId = null

  setBusy(true)
  setStatus('thinking')

  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        sessionId: state.sessionId,
        attachments: attachment ? [attachment] : [],
      }),
    })

    if (!res.ok) {
      let errText = `请求失败（${res.status}）`
      try {
        const j = await res.json()
        if (j.error) errText = j.error
      } catch {
        /* ignore */
      }
      throw new Error(errText)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (!part.trim() || part.startsWith(':')) continue
        let event = 'message'
        const dataLines = []
        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (!dataLines.length) continue

        let payload
        try {
          payload = JSON.parse(dataLines.join('\n'))
        } catch {
          continue
        }

        if (event === 'session') {
          state.sessionId = payload.id
          if (payload.title) els.sessionTitle.textContent = payload.title
        } else if (event === 'status' && payload.status) {
          setStatus(payload.status)
        } else if (event === 'hitl') {
          enqueueHitl(payload)
        } else if (event === 'tool') {
          if (payload.messageId && payload.messageId !== messageId) {
            messageId = payload.messageId
            assistant.row.dataset.messageId = messageId
            state.live.delete('pending')
            state.live.set(messageId, assistant)
          }
          if (payload.tool) {
            assistant.tools.set(payload.tool.id, payload.tool)
            mountToolCard(assistant.toolsEl, payload.tool)
            scrollToBottom()
          }
        } else if (event === 'chunk' && payload.text) {
          if (payload.messageId && payload.messageId !== messageId) {
            messageId = payload.messageId
            assistant.row.dataset.messageId = messageId
            state.live.delete('pending')
            state.live.set(messageId, assistant)
          }
          streamView.append(payload.text)
        } else if (event === 'done') {
          if (payload.content) streamView.setFull(payload.content)
          streamView.flush()
          messageId = payload.messageId || messageId

          if (payload.tools?.length) {
            for (const tool of payload.tools) {
              assistant.tools.set(tool.id, tool)
              mountToolCard(assistant.toolsEl, tool)
            }
          }
          if (payload.filesWritten?.length) {
            assistant.metaEl.hidden = false
            assistant.metaEl.innerHTML = payload.filesWritten
              .map((f) => `<span class="chip">📄 ${escapeHtml(f)}</span>`)
              .join('')
            await loadFiles()
          }
          if (payload.title) els.sessionTitle.textContent = payload.title
          if (payload.sessionId) state.sessionId = payload.sessionId
          // 输出完成后把执行细节收起，让最终结果成为页面主角。
          if (assistant.executionEl) assistant.executionEl.open = false
          if (assistant.stateEl) assistant.stateEl.textContent = '已完成'
          await loadSessions()
          setStatus('done')
        } else if (event === 'error') {
          // requestId 可直接关联服务端 Pino 日志和 Sentry 事件，方便用户反馈问题。
          const reference = payload.requestId ? `\n问题编号：${payload.requestId}` : ''
          const error = new Error(`${payload.error || '未知错误'}${reference}`)
          error.code = payload.code
          error.retryable = payload.retryable
          throw error
        } else if (event === 'cancelled') {
          // 保留已收到的部分输出，方便用户判断是否需要重试。
          streamView.flush()
          if (assistant.stateEl) assistant.stateEl.textContent = '已取消'
          if (payload.error && payload.requestId) {
            appendError(`${payload.error}\n问题编号：${payload.requestId}`)
          }
          setStatus('ready')
        }
      }
    }

    const full = streamView.flush()
    if (!full && !assistant.contentEl.innerHTML) {
      assistant.contentEl.textContent = '（没有收到模型输出）'
    }
  } catch (err) {
    console.error(err)
    streamView.flush()
    assistant.row?.remove()
    appendError(err.message || String(err))
    setStatus('error')
  } finally {
    setBusy(false)
    if (!els.hitlModal.hidden) {
      state.hitlQueue = []
      state.hitlCurrent = null
      els.hitlModal.hidden = true
    }
    if (els.statusText.textContent !== '出错') setStatus('ready')
    els.input.focus()
  }
}

/* ── Input UX ───────────────────────────────────────────── */
function autoResize() {
  const el = els.input
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  els.btnSend.disabled = !canSendMessage()
}

els.input.addEventListener('input', autoResize)
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // HITL 弹窗打开时交给全局 Enter
    if (!els.hitlModal.hidden) return
    e.preventDefault()
    if (canSendMessage()) sendMessage()
  }
})
els.composer.addEventListener('submit', (e) => {
  e.preventDefault()
  sendMessage()
})
els.btnClear.addEventListener('click', () => clearCurrentSession())
els.btnNewChat.addEventListener('click', () => createSession())
els.btnToggleSidebar.addEventListener('click', () => {
  if (window.matchMedia('(max-width: 860px)').matches) {
    els.app.classList.toggle('sidebar-open')
  } else {
    els.app.classList.toggle('sidebar-collapsed')
  }
})
els.suggestions?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-prompt]')
  if (!btn) return
  sendMessage(btn.dataset.prompt)
})

/* ── Boot ───────────────────────────────────────────────── */
async function boot() {
  // 无鉴权时直接显示主界面；有鉴权则先过门禁
  const ok = await ensureAuthorized()
  if (!ok) return

  hideAuthGate()
  await loadMeta()
  await loadWorkspaces()
  await loadSessions()
  if (state.sessionId) {
    await openSession(state.sessionId)
  } else {
    await createSession()
  }
  await loadFiles()
  autoResize()
  els.input.focus()
  setStatus('ready')
}

// 初始隐藏主界面，避免未登录闪屏
if (els.app) els.app.hidden = true
document.body.classList.add('auth-locked')

boot().catch((err) => {
  console.error(err)
  hideAuthGate()
  appendError('初始化失败：' + (err.message || String(err)))
})
