/**
 * Turns a session's raw events (seq order, as uploaded by dsh_session_log) into what the console's
 * conversation view reads: a session overview, and turns made of user messages, model steps, tool
 * call/result pairs and one-line notes. No DOM here, so it is tested on its own. Nothing is
 * dropped: every event lands in exactly one item (bookkeeping as `internal`, which the view hides
 * unless asked), and every item keeps the raw events it was made from for "查看 JSON".
 */

/** Session-wide settings; shown as chips in the overview, not as entries. */
export const SETTING_TYPES = ['permission/preset', 'sandbox/mode', 'approval/policy']

/** Bookkeeping that would bury the conversation. Hidden unless "显示内部事件" is on. */
export const INTERNAL_TYPES = new Set([
  'agent/inbox/spliced', 'step/start', 'step/end', 'turn/start', 'turn/end', 'request/header', 'request/context',
  'session/title-llm-request', 'system/message', 'session/end-seed', 'assistant/attempt', 'llm/retry-started',
  'job/registered', 'job/settled', 'workspace/changes', 'compaction/start', 'compaction/prune', 'subagent/descriptor',
  ...SETTING_TYPES,
])

const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** The text of message content parts; non-text parts become a short placeholder. */
export function contentText(content, types = ['text']) {
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : [])
    .map(part => (types.includes(part?.type) ? part.text ?? ''
      : part?.type === 'image' ? '[图片]' : part?.type === 'file' ? '[文件]' : ''))
    .filter(Boolean).join('\n')
}

// What a non-user `user/message` is, by its source kind.
const CONTEXT_KINDS = {
  'runtime-context': '运行环境', 'skill-catalog': '技能清单', 'agent-instructions': '代理说明', 'time-context': '时间',
  'model-selection': '模型切换说明',
}
export const contextLabel = kind => CONTEXT_KINDS[kind] ?? (kind ? `上下文（${kind}）` : '上下文')

// A user/message is the person speaking only when its source says so. Older events carry no source
// at all; those count as the user unless the text is plainly injected context.
function spokenByUser(data) {
  const kind = object(data.source).kind
  if (kind) return kind === 'user'
  const text = contentText(data.content) || (typeof data.text === 'string' ? data.text : '')
  return !/^\s*(<system-reminder>|Current runtime context)/u.test(text)
}

const userText = data => contentText(data.content) || (typeof data.text === 'string' ? data.text : '')

/** Tokens of one model step, as the step reported them. */
export function usageOf(data) {
  const usage = object(data.usage)
  const number = value => (Number.isFinite(value) ? value : 0)
  return {
    input: number(usage.inputTokens), output: number(usage.outputTokens),
    cacheRead: number(usage.cacheReadTokens), cacheWrite: number(usage.cacheWriteTokens), total: number(usage.totalTokens),
  }
}

// A note: one grey line, optionally with something to expand.
const note = (events, text, { detail = '', tone = '' } = {}) => ({ kind: 'note', events, text, detail, tone })
const modelName = data => [data.provider, data.model].filter(Boolean).join(' / ')

/**
 * Groups events into `{ overview, opening, turns }`.
 * - overview: the latest value of each session setting, distinct system prompts, sub-agent descriptor;
 * - opening: items before the first turn starts;
 * - turns: `{ turn, startedAt, endedAt, reason, items }`, one per `turn/start`.
 * Items: user | context | model | tool | note | other | internal, each with the `events` behind it.
 */
export function groupConversation(events) {
  const overview = { settings: {}, systemPrompts: [], descriptor: null }
  const opening = { turn: null, items: [] }
  const turns = []
  let group = opening
  let lastModel = null
  const tools = new Map()
  const approvals = new Map()
  const commands = new Map()
  const push = item => { group.items.push(item); return item }
  // Consecutive injected context messages fold into one block.
  const context = (event, kind) => {
    const last = group.items.at(-1)
    if (last?.kind === 'context') { last.events.push(event); last.kinds.push(kind); return }
    push({ kind: 'context', events: [event], kinds: [kind] })
  }

  for (const event of events) {
    const data = object(event.data)
    const type = event.type
    if (event.unavailable) { push({ kind: 'other', events: [event], missing: true }); continue }
    if (SETTING_TYPES.includes(type)) overview.settings[type] = data.preset ?? data.mode ?? data.policy ?? null
    if (type === 'subagent/descriptor') overview.descriptor = data
    if (type === 'system/message') {
      const text = contentText(object(data.message).content)
      if (text && !overview.systemPrompts.includes(text)) overview.systemPrompts.push(text)
    }
    if (type === 'request/context' && data.model) lastModel = modelName(data)

    switch (type) {
      case 'turn/start':
        group = { turn: Number.isSafeInteger(data.turn) ? data.turn : turns.length + 1, startedAt: event.time ?? null,
          endedAt: null, reason: null, items: [] }
        turns.push(group)
        push({ kind: 'internal', events: [event] })
        break
      case 'turn/end':
        if (group !== opening) { group.endedAt = event.time ?? null; group.reason = object(data.reason) }
        push({ kind: 'internal', events: [event] })
        break
      case 'user/message':
        if (spokenByUser(data)) push({ kind: 'user', events: [event], text: userText(data) })
        else context(event, object(data.source).kind ?? null)
        break
      case 'assistant/message': {
        const message = object(data.message)
        const source = object(message.source)
        push({
          kind: 'model', events: [event], step: Number.isSafeInteger(data.step) ? data.step : null,
          model: modelName(source) || lastModel || '',
          reasoning: contentText(message.content, ['reasoning']), text: contentText(message.content, ['text']),
          usage: usageOf(data), interrupted: data.interrupted === true,
        })
        break
      }
      case 'tool/call': {
        const item = push({ kind: 'tool', events: [event], name: data.name || '工具', arguments: data.arguments ?? '', result: null })
        if (data.callId) tools.set(data.callId, item)
        break
      }
      case 'tool/result': {
        const message = object(data.message)
        const callId = message.toolCallId ?? object(message.source).callId ?? data.callId
        const result = { event, text: contentText(message.content), error: message.isError === true || Boolean(data.error), meta: data.meta ?? null }
        const item = callId && tools.get(callId)
        if (item && !item.result) { item.result = result; item.events.push(event) }
        else push({ kind: 'tool', events: [event], name: '工具结果', arguments: null, result })
        break
      }
      case 'model/selection': {
        const name = modelName(data)
        // The kernel announces the model at start and re-announces it often; only a change is worth a line.
        if (name && lastModel && name !== lastModel) push(note([event], `模型切换为 ${name}`))
        else push({ kind: 'internal', events: [event] })
        if (name) lastModel = name
        break
      }
      case 'approval/asked': {
        const item = push(note([event], `审批请求：${[data.toolName, data.reason].filter(Boolean).join(' · ') || '—'}`, { tone: 'warn' }))
        if (data.id) approvals.set(data.id, item)
        break
      }
      case 'approval/decided': {
        const item = data.id && approvals.get(data.id)
        const outcome = APPROVAL_OUTCOMES[data.outcome] ?? data.outcome ?? '—'
        if (item) { item.text += ` → ${outcome}`; item.events.push(event) }
        else push(note([event], `审批结果：${outcome}`, { tone: 'warn' }))
        break
      }
      case 'compaction/summary': {
        const usage = usageOf(data)
        push(note([event], `上下文压缩${data.shadowedTokenCount ? `：折叠约 ${data.shadowedTokenCount.toLocaleString('zh-CN')} token` : ''}${
          data.model ? ` · ${modelName(data)}` : ''}${usage.total ? ` · 用量 ${usage.total.toLocaleString('zh-CN')} token` : ''}`,
        { detail: contentText(data.summary) }))
        break
      }
      case 'compaction/end':
        if (data.error) push(note([event], `上下文压缩失败：${data.error}`, { tone: 'error' }))
        else push({ kind: 'internal', events: [event] })
        break
      case 'session/title':
        push(note([event], `会话标题：${data.title ?? ''}`))
        break
      case 'command/run': {
        const item = push(note([event], `命令 /${data.name ?? ''}${data.args ? ' ' + data.args : ''}`))
        if (data.commandId) commands.set(data.commandId, item)
        break
      }
      case 'command/done': {
        const item = data.commandId && commands.get(data.commandId)
        const failed = data.kind === 'error'
        if (item) {
          item.text += failed ? ' → 失败' : ' → 完成'
          item.detail = data.text ?? ''
          if (failed) item.tone = 'error'
          item.events.push(event)
        } else push(note([event], failed ? '命令失败' : '命令完成', { detail: data.text ?? '', tone: failed ? 'error' : '' }))
        break
      }
      case 'llm/retry': {
        const failure = object(data.failure)
        push(note([event], `模型请求重试 ${data.retry ?? '?'}${data.maxRetries ? `/${data.maxRetries}` : ''}：${
          [failure.code, failure.message].filter(Boolean).join(' ') || '未知原因'}`, { tone: 'warn' }))
        break
      }
      case 'deliverables/presented': {
        const files = Array.isArray(data.files) ? data.files : []
        push(note([event], `交付文件 ${files.length} 个：${files.map(file => file?.path).filter(Boolean).join('、')}`,
          { detail: files.map(file => [file?.path, file?.description].filter(Boolean).join(' — ')).join('\n') }))
        break
      }
      case 'subagent/catalog':
        push({ ...note([event], `派出子代理：${data.label || data.childId || '—'}${data.mode ? `（${data.mode}）` : ''}`), childId: data.childId ?? null })
        break
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos : []
        push(note([event], `待办清单更新：${todos.length} 项`,
          { detail: todos.map(todo => `[${TODO_STATES[todo?.status] ?? todo?.status ?? ' '}] ${todo?.content ?? ''}`).join('\n') }))
        break
      }
      case 'developer/message': {
        const parts = Array.isArray(object(data.message).content) ? data.message.content : []
        const added = parts.filter(part => part?.type === 'tool-addition').map(part => part.toolName)
        const removed = parts.filter(part => part?.type === 'tool-removal').map(part => part.toolName)
        push(note([event], ['可用工具变化', added.length ? `新增 ${added.join('、')}` : '', removed.length ? `移除 ${removed.join('、')}` : '']
          .filter(Boolean).join('：')))
        break
      }
      case 'working-directory/change':
        push(note([event], `工作目录改为 ${data.cwd ?? ''}`))
        break
      default:
        // Anything this view does not know is kept as 'other': the kernel adds new types over time.
        push({ kind: INTERNAL_TYPES.has(type) ? 'internal' : 'other', events: [event] })
    }
  }
  return { overview, opening, turns }
}

const APPROVAL_OUTCOMES = { approved: '已批准', approve: '已批准', allowed: '已批准', denied: '已拒绝', deny: '已拒绝', rejected: '已拒绝', cancelled: '已取消' }
const TODO_STATES = { completed: 'x', in_progress: '~', pending: ' ' }

/** "完成" / "出错：…" / "已中断" for a turn's end reason. */
export function turnEnding(reason) {
  if (!reason) return '未结束'
  if (reason.kind === 'completed') return '完成'
  if (reason.kind === 'error') return `出错：${[reason.error?.code, reason.error?.message].filter(Boolean).join(' ') || '未知原因'}`
  if (reason.kind === 'aborted') return reason.reason?.kind === 'user' ? '用户中断' : '已中断'
  return reason.kind ?? '—'
}

/** "12 秒" / "1 分 32 秒" / "2 小时 5 分"; empty for an unknown or negative span. */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    : `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}

/**
 * What a turn shows by default and what it folds away: `users` (what the person typed), `answer`
 * (the last model step with text, as it is, however the turn ended — or null), `process` (every
 * other item, in order, the answer's own step included so its reasoning and usage stay reachable),
 * and `ending`: the grey line under the answer. A turn that completed with an answer needs none;
 * an interrupted, failed or unfinished one says how it ended, and one without any text says
 * 「没有回答」 plus how it ended.
 */
export function splitTurn(group) {
  const users = group.items.filter(item => item.kind === 'user')
  const answer = group.items.findLast(item => item.kind === 'model' && item.text) ?? null
  const process = group.items.filter(item => item.kind !== 'user')
  const ending = !answer ? `没有回答 · ${turnEnding(group.reason)}`
    : group.reason?.kind === 'completed' ? null : turnEnding(group.reason)
  return { users, answer, process, ending }
}

/** The fold's one-line title, e.g. 「过程 · 3 步 · 工具 5 次（read_file ×2、run_command ×3） · 用时 1 分 32 秒 · 1 次重试」. */
export function processSummary(group, process = splitTurn(group).process) {
  const parts = ['过程']
  const steps = process.filter(item => item.kind === 'model').length
  if (steps) parts.push(`${steps} 步`)
  const tools = process.filter(item => item.kind === 'tool')
  if (tools.length) {
    const counts = new Map()
    for (const item of tools) counts.set(item.name, (counts.get(item.name) ?? 0) + 1)
    const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    parts.push(`工具 ${tools.length} 次（${names.slice(0, 4).join('、')}${names.length > 4 ? ` 等 ${names.length} 种` : ''}）`)
  }
  const failedTools = tools.filter(item => item.result?.error).length
  if (failedTools) parts.push(`${failedTools} 次工具出错`)
  if (Number.isFinite(group.startedAt) && Number.isFinite(group.endedAt)) {
    const spent = durationText(group.endedAt - group.startedAt)
    if (spent) parts.push(`用时 ${spent}`)
  }
  const count = (test, label) => { const total = process.filter(item => item.kind === 'note' && test(item.events[0]?.type)).length; if (total) parts.push(`${total} 次${label}`) }
  count(type => type === 'llm/retry', '重试')
  count(type => type === 'approval/asked', '审批')
  count(type => type === 'compaction/summary', '上下文压缩')
  if (parts.length === 1) parts.push(process.some(item => item.kind !== 'internal') ? '没有模型步骤' : '只有内部事件')
  return parts.join(' · ')
}

/** The whole session in the upload format, exactly as the server's raw download writes it. */
export function rawDocument(header, events, formatVersion, id) {
  return JSON.stringify({ ...(header ?? { version: null, sessionFormatVersion: formatVersion, session: { id } }), events }, null, 2) + '\n'
}

/** A one-line summary of tool arguments: the JSON keys and short values, clipped. */
export function argumentSummary(value, length = 160) {
  let parsed = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { parsed = value } }
  let text
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    text = Object.entries(parsed).map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`).join(' · ')
  } else text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed) ?? ''
  text = text.replace(/\s+/gu, ' ').trim()
  return text.length > length ? text.slice(0, length) + '…' : text
}
