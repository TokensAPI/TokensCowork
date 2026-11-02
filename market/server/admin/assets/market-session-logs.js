import { sessionLogDetailView } from './market-session-log-detail.js'

/**
 * The session-log page: the index of sessions the desktop plugin uploaded and the retention
 * setting; one opened session is shown by market-session-log-detail.js. Platform administrators
 * only. Every byte shown here is user content (files, commands, secrets), so it is only ever placed
 * with textContent, and each opened session and each download is recorded by the server.
 */
export function sessionLogsView({ $, node, button, json, action, formatTime }) {
  let page = 1,
    filters = {},
    total = 0,
    pageSize = 50
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
  const detail = sessionLogDetailView({ $, node, button, json, action, formatTime }, { keyLines, clientText, onBack: back })

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

  // ── Detail ─────────────────────────────────────────────────────────────────
  async function open(id, formatVersion) {
    await detail.open(id, formatVersion)
    $('session-log-browser').hidden = true
    $('session-log-detail').hidden = false
    $('session-log-detail').scrollIntoView?.({ block: 'start' })
  }
  function back() {
    detail.close()
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

  return {
    // Loaded when the page is opened, not with the rest of the console: it is the one page that
    // may be unconfigured, and it should not keep the others from loading.
    async show() {
      if (detail.isOpen()) return
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
