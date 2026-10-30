/**
 * The session-log page: the index of sessions the desktop plugin uploaded, the retention setting,
 * and a timeline replay of one session. Platform administrators only. Every byte shown here is
 * user content (files, commands, secrets), so it is only ever placed with textContent, and each
 * opened session is recorded by the server.
 */
export function sessionLogsView({ $, node, button, json, action, formatTime }) {
  let page = 1,
    filters = {},
    total = 0,
    pageSize = 50,
    current = null,
    next = null,
    loaded = 0
  const LONG = 600
  const DAY = 24 * 60 * 60 * 1000
  const short = (value, length = 12) => (value ? value.slice(0, length) : '')
  const bytes = (value) => (value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`)
  const time = (value) => (value ? formatTime(value) : '—')
  // The Key in full when the server kept it (sealed); otherwise only its fingerprint is known.
  function keyLines(target, { key, fingerprint, label }) {
    if (label) target.append(node('div', label))
    if (key) target.append(node('div', key, 'key-value'))
    else target.append(node('div', `未保存原文 · 指纹 ${short(fingerprint, 16)}`, 'fingerprint muted'))
  }
  const clientText = (client) => [client.product, client.version, client.platform].filter(Boolean).join(' ') || '—'

  // ── List ───────────────────────────────────────────────────────────────────
  function readFilters() {
    const day = (id, offset = 0) => {
      const value = $(id).value
      return value ? String(new Date(value + 'T00:00:00').getTime() + offset) : ''
    }
    return {
      account: $('session-log-account').value.trim(), key: $('session-log-key').value.trim(),
      clientVersion: $('session-log-version').value.trim(), model: $('session-log-model').value.trim(),
      from: day('session-log-from'), to: day('session-log-to', DAY),
    }
  }
  async function loadList() {
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), page: String(page) })
    const result = await json('/api/v1/session-logs?' + query)
    total = result.total
    pageSize = result.pageSize
    $('session-log-list').replaceChildren(...result.items.map(row))
    $('session-log-empty').hidden = result.items.length > 0
    $('session-log-key-note').hidden = result.keyDisplayReady
    const pages = Math.max(1, Math.ceil(total / pageSize))
    $('session-log-page').textContent = `第 ${page} / ${pages} 页 · 共 ${total} 个会话`
    $('session-log-prev').disabled = page <= 1
    $('session-log-next').disabled = page >= pages
    $('session-logs-note').textContent = Object.values(filters).some(Boolean) ? `筛选结果 ${total} 个会话。` : `共 ${total} 个会话。`
  }
  function row(item) {
    const tr = document.createElement('tr')
    const name = node('td')
    const id = node('div', item.id.length > 24 ? item.id.slice(0, 22) + '…' : item.id, 'fingerprint muted')
    id.title = item.id
    name.append(node('strong', item.title || '未命名会话'), id,
      node('div', clientText(item.client) + (item.parentSession ? ' · 子代理会话' : ''), 'muted'))
    const key = node('td')
    if (item.keyFingerprint) keyLines(key, { key: item.key, fingerprint: item.keyFingerprint, label: item.keyLabel })
    else key.append(node('span', '未带 Key（匿名）', 'muted'))
    const usage = node('td')
    usage.append(node('div', item.models.join('、') || '—'))
    if (item.tokens.total) usage.append(node('div', `${item.tokens.total.toLocaleString('zh-CN')} token`, 'muted'))
    const events = node('td', `${item.eventCount} 条 · ${bytes(item.storedBytes)}${item.missingEvents ? ` · 缺 ${item.missingEvents} 条` : ''}`)
    const actions = node('div', '', 'row-actions'),
      cell = document.createElement('td')
    actions.append(
      button('查看', () => action(() => open(item.id, item.formatVersion))),
      button('删除', () => {
        if (!confirm(`删除会话「${item.title || item.id}」的全部日志？此操作不可恢复。`)) return
        action(async () => {
          await json(`/api/v1/session-logs/${encodeURIComponent(item.id)}/${item.formatVersion}`, undefined, 'DELETE')
          await loadList()
        }, { success: '会话日志已删除。' })
      }, 'quiet danger'),
    )
    cell.append(actions)
    tr.append(name, node('td', item.accountId || '—', item.accountId ? '' : 'muted'), key, usage, events, node('td', time(item.lastReceivedAt)), cell)
    return tr
  }

  // ── Detail: a timeline replay ──────────────────────────────────────────────
  const textOf = (content) => (Array.isArray(content) ? content : [])
    .map((part) => (part?.type === 'text' || part?.type === 'reasoning' ? part.text
      : part?.type === 'image' ? '[图片]' : part?.type === 'file' ? '[文件]' : part?.type === 'tool-call' ? '' : part?.type ? `[${part.type}]` : ''))
    .filter(Boolean).join('\n')
  // Long content starts folded; the summary line shows its beginning. Conversation text keeps the
  // page font, tool input and output are shown as code.
  function body(text, folded = text.length > LONG, code = folded) {
    const full = node('pre', text, code ? 'log-text log-code' : 'log-text')
    if (!folded) return full
    const details = document.createElement('details')
    details.append(node('summary', text.slice(0, 160).replace(/\s+/gu, ' ') + (text.length > 160 ? '…' : '')), full)
    return details
  }
  const pretty = (value) => {
    if (typeof value !== 'string') return JSON.stringify(value, null, 2)
    try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
  }
  function entry(event) {
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const item = node('li', '', 'log-event'),
      head = node('div', '', 'log-head')
    const add = (...children) => item.append(...children)
    const label = (text, kind = '') => head.prepend(node('span', text, 'chip' + (kind ? ' ' + kind : '')))
    head.append(node('span', `#${event.seq}`, 'muted'), node('time', time(event.time), 'muted'))
    item.append(head)
    if (event.unavailable) {
      label(event.type || '事件', 'disabled')
      add(node('p', '原文对象缺失，只剩索引。', 'muted'))
      return item
    }
    switch (event.type) {
      case 'user/message':
        label('用户')
        add(body(textOf(data.content) || pretty(data), false, false))
        break
      case 'assistant/message': {
        label('模型')
        const content = Array.isArray(data.message?.content) ? data.message.content : []
        const thinking = content.filter((part) => part.type === 'reasoning').map((part) => part.text).join('\n')
        const answer = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        if (thinking) {
          const details = document.createElement('details')
          details.append(node('summary', '思考过程'), node('pre', thinking, 'log-text muted'))
          add(details)
        }
        if (answer) add(body(answer, answer.length > LONG, false))
        const source = data.message?.source ?? {}
        const usage = data.usage ?? {}
        add(node('p', [[source.provider, source.model].filter(Boolean).join(' / '),
          usage.totalTokens ? `输入 ${usage.inputTokens ?? 0} · 输出 ${usage.outputTokens ?? 0} · 共 ${usage.totalTokens} token` : '',
          data.interrupted ? '已中断' : ''].filter(Boolean).join(' · '), 'muted'))
        break
      }
      case 'tool/call':
        label('工具调用')
        add(node('strong', data.name || '工具'), body(pretty(data.arguments ?? ''), true))
        break
      case 'tool/result': {
        const failed = data.message?.isError || data.error
        label(failed ? '工具出错' : '工具结果', failed ? 'disabled' : '')
        add(body(textOf(data.message?.content) || pretty(data.error ?? data.meta ?? {}), true))
        break
      }
      case 'system/message':
      case 'developer/message':
        label(event.type === 'system/message' ? '系统消息' : '开发者消息')
        add(body(textOf(data.message?.content) || pretty(data), true))
        break
      case 'approval/asked':
        label('审批请求')
        add(node('p', [data.toolName, data.reason].filter(Boolean).join(' · ')))
        break
      case 'approval/decided':
        label('审批结果')
        add(node('p', data.outcome || '—'))
        break
      case 'model/selection':
      case 'request/context':
        label('模型')
        add(node('p', [data.provider, data.model].filter(Boolean).join(' / ') + (data.contextWindow ? ` · 上下文 ${data.contextWindow}` : ''), 'muted'))
        break
      case 'session/title':
        label('标题')
        add(node('p', data.title || ''))
        break
      case 'turn/start':
        label('新一轮')
        add(node('p', `第 ${data.turn ?? '?'} 轮`, 'muted'))
        break
      case 'compaction/summary':
        label('压缩')
        add(body(textOf(data.summary) || pretty(data), true))
        break
      default:
        if (String(event.type).startsWith('compaction/')) label('压缩')
        else label(event.type || '事件', 'disabled')
        add(body(pretty(data), true))
    }
    return item
  }
  // Bookkeeping events would bury the conversation; the replay leaves them out.
  const QUIET = new Set(['step/start', 'step/end', 'turn/end', 'assistant/attempt', 'llm/retry-started', 'request/header', 'workspace/changes'])
  async function loadEvents() {
    const query = new URLSearchParams({ after: String(next ?? -1), limit: '200' })
    const result = await json(`/api/v1/session-logs/${encodeURIComponent(current.id)}/${current.formatVersion}?${query}`)
    current = result.session
    showMeta()
    showKeys(result.keys)
    const visible = result.events.filter((event) => !QUIET.has(event.type))
    $('session-log-timeline').append(...visible.map(entry))
    loaded += result.events.length
    next = result.next
    $('session-log-more').hidden = next === null
    $('session-log-timeline-empty').hidden = $('session-log-timeline').children.length > 0
    $('session-log-loaded').textContent = `已读取 ${loaded} / ${current.eventCount} 条事件（流程记录已省略）`
  }
  function showMeta() {
    $('session-log-title').textContent = current.title || current.id
    $('session-log-meta').textContent = [
      current.id, `格式 v${current.formatVersion}`, `上报账号 ${current.accountId || '—'}（未核验）`, clientText(current.client),
      current.cwd ? `目录 ${current.cwd}` : '', `创建 ${time(current.createdAt)}`, `最近上传 ${time(current.lastReceivedAt)}`,
      current.missingEvents ? `缺 ${current.missingEvents} 条事件` : '',
    ].filter(Boolean).join(' · ')
    $('session-log-parent').hidden = !current.parentSession
  }
  // Every Key the session was uploaded with, oldest first.
  function showKeys(keys) {
    const list = $('session-log-keys')
    list.replaceChildren()
    if (!keys.length) return list.append(node('p', '未带 Key（匿名）', 'muted'))
    for (const item of keys) {
      const line = node('div', '', 'session-log-key')
      line.append(node('div', `Key · 首次 ${time(item.firstUsedAt)} · 最近 ${time(item.lastUsedAt)}`, 'muted'))
      keyLines(line, item)
      list.append(line)
    }
  }
  async function open(id, formatVersion) {
    current = { id, formatVersion }
    next = null
    loaded = 0
    $('session-log-timeline').replaceChildren()
    await loadEvents()
    $('session-log-browser').hidden = true
    $('session-log-detail').hidden = false
    $('session-log-detail').scrollIntoView?.({ block: 'start' })
  }
  function back() {
    current = null
    $('session-log-timeline').replaceChildren()
    $('session-log-keys').replaceChildren()
    $('session-log-detail').hidden = true
    $('session-log-browser').hidden = false
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  $('session-log-filters').onsubmit = (event) => {
    event.preventDefault()
    filters = readFilters()
    page = 1
    action(loadList)
  }
  $('session-log-reset').onclick = () => {
    $('session-log-filters').reset()
    filters = {}
    page = 1
    action(loadList)
  }
  $('session-log-prev').onclick = () => { page -= 1; action(loadList) }
  $('session-log-next').onclick = () => { page += 1; action(loadList) }
  $('session-log-range-delete').onclick = () => {
    const range = readFilters()
    if (!range.from || !range.to) return action(async () => { throw new Error('请先选择起止日期。') })
    if (!confirm(`删除创建于 ${$('session-log-from').value} 至 ${$('session-log-to').value} 的全部会话日志？此操作不可恢复。`)) return
    action(async () => {
      const result = await json('/api/v1/session-logs', { from: Number(range.from), to: Number(range.to) }, 'DELETE')
      await loadList()
      $('session-logs-note').textContent = `已删除 ${result.count} 个会话。`
    }, { success: '已按日期删除。' })
  }
  $('session-log-settings').onsubmit = (event) => {
    event.preventDefault()
    const value = $('session-log-retention').value.trim()
    action(async () => {
      const saved = await json('/api/v1/session-logs/settings', { retentionDays: value ? Number(value) : null })
      $('session-log-retention').value = saved.retentionDays ?? ''
    }, { success: value ? `保留期已设为 ${value} 天。` : '已改为永久保留。' })
  }
  $('session-log-back').onclick = back
  $('session-log-more').onclick = () => action(loadEvents)
  // A sub-agent session links to the session that started it.
  $('session-log-parent').onclick = () => action(async () => {
    const found = await json('/api/v1/session-logs?' + new URLSearchParams({ session: current.parentSession }))
    if (!found.items.length) throw new Error('父会话的日志不在这里（可能未上传或已删除）。')
    await open(found.items[0].id, found.items[0].formatVersion)
  })

  return {
    // Loaded when the page is opened, not with the rest of the console: it is the one page that
    // may be unconfigured, and it should not keep the others from loading.
    async show() {
      if (current) return
      const settings = await json('/api/v1/session-logs/settings')
      $('session-log-retention').value = settings.retentionDays ?? ''
      await loadList()
    },
    clear() {
      back()
      filters = {}
      page = 1
      $('session-log-filters').reset()
      $('session-log-list').replaceChildren()
    },
  }
}
