import { sessionLogDetailView } from './market-session-log-detail.js'

/**
 * The session-log page: the index of sessions the desktop plugin uploaded, paged on the server,
 * with filters, ticked-row and date-range deletion (each confirmed in a dialog first), a note and
 * tags per session, and the retention setting; one opened session is shown by
 * market-session-log-detail.js. Platform administrators only. Every byte shown here is user content
 * (files, commands, secrets), so it is only ever placed with textContent, and each opened session
 * and each download is recorded by the server.
 *
 * The pager and the bulk buttons are rebuilt on every load rather than toggled: action() puts every
 * control it disabled back the way it found it, which used to undo the prev/next states a load had
 * just set (page 2 of 3 kept 「上一页」 disabled, and 「下一页」 ran past the last page).
 */
export function sessionLogsView({ $, node, button, json, action, formatTime }) {
  const DAY = 24 * 60 * 60 * 1000
  let page = 1,
    pageSize = 50,
    filters = {},
    total = 0,
    items = []
  // The ticked rows of the page on screen, by `${id}:${formatVersion}`. Cleared whenever the page
  // or the filters change, so a deletion only ever names rows the administrator can see.
  const selected = new Map()
  const short = (value, length = 12) => (value ? value.slice(0, length) : '')
  const bytes = (value) => (value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`)
  const time = (value) => (value ? formatTime(value) : '—')
  const nameOf = (item) => `${item.id}:${item.formatVersion}`
  const titleOf = (item) => item.title || '未命名会话'
  const filtering = () => Object.values(filters).some(Boolean)
  // The Key in full when the server kept it (sealed); otherwise only its fingerprint is known.
  function keyLines(target, { key, fingerprint, label }) {
    if (label) target.append(node('div', label))
    if (key) target.append(node('div', key, 'key-value'))
    else target.append(node('div', `未保存原文 · 指纹 ${short(fingerprint, 16)}`, 'fingerprint muted'))
  }
  const clientText = (client) => [client.product, client.version, client.platform].filter(Boolean).join(' ') || '—'
  const detail = sessionLogDetailView({ $, node, button, json, action, formatTime }, { keyLines, clientText, onBack: back })

  // ── Confirmation ───────────────────────────────────────────────────────────
  // Every deletion asks here first: what goes, how many, and that it cannot be undone.
  function confirmDelete(text, sessions = []) {
    const dialog = $('session-log-confirm-dialog')
    $('session-log-confirm-text').textContent = text
    const shown = sessions.slice(0, 8).map((item) => node('li', `${titleOf(item)} · ${item.id}`))
    if (sessions.length > shown.length) shown.push(node('li', `…以及另外 ${sessions.length - shown.length} 个`, 'muted'))
    $('session-log-confirm-list').replaceChildren(...shown)
    $('session-log-confirm-list').hidden = !shown.length
    return new Promise((resolve) => {
      dialog.returnValue = ''
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true })
      dialog.showModal()
    })
  }

  // ── List ───────────────────────────────────────────────────────────────────
  function readFilters() {
    const day = (id, offset = 0) => {
      const value = $(id).value
      return value ? String(new Date(value + 'T00:00:00').getTime() + offset) : ''
    }
    return {
      account: $('session-log-account').value.trim(), session: $('session-log-session').value.trim(),
      key: $('session-log-key').value.trim(), tag: $('session-log-tag').value.trim(),
      clientVersion: $('session-log-version').value.trim(), model: $('session-log-model').value.trim(),
      from: day('session-log-from'), to: day('session-log-to', DAY),
    }
  }
  async function loadList() {
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      page: String(page), pageSize: String(pageSize) })
    const result = await json('/api/v1/session-logs?' + query)
    total = result.total
    // The server answers a page past the end with the last page; follow it.
    page = result.page
    pageSize = result.pageSize
    items = result.items
    selected.clear()
    $('session-log-list').replaceChildren(...items.map(row))
    $('session-log-empty').hidden = items.length > 0
    $('session-log-empty').textContent = filtering() ? '没有符合条件的会话。' : '暂无会话日志。'
    $('session-log-key-note').hidden = result.keyDisplayReady
    $('session-log-page-size').value = String(pageSize)
    $('session-logs-note').textContent = filtering() ? `筛选结果 ${total} 个会话。` : `共 ${total} 个会话。`
    renderPager()
    renderSelection()
  }
  function goTo(target) {
    page = target
    action(loadList)
  }
  // 「上一页 1 … 4 5 [6] 7 8 … 20 下一页」, rebuilt from scratch on every load.
  function renderPager() {
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const first = total ? (page - 1) * pageSize + 1 : 0
    $('session-log-page').textContent = `第 ${first}-${Math.min(total, page * pageSize)} 条 · 共 ${total} 个会话 · 第 ${page} / ${pages} 页`
    const numbers = new Set([1, pages])
    for (let n = page - 2; n <= page + 2; n++) if (n >= 1 && n <= pages) numbers.add(n)
    const controls = []
    const step = (label, target, disabled, aria) => {
      const el = button(label, () => goTo(target), 'secondary log-page-step')
      el.disabled = disabled
      el.setAttribute('aria-label', aria)
      return el
    }
    controls.push(step('上一页', page - 1, page <= 1, '上一页'))
    let last = 0
    for (const n of [...numbers].sort((a, b) => a - b)) {
      if (n - last > 1) controls.push(node('span', '…', 'log-page-gap muted'))
      const el = button(String(n), () => goTo(n), n === page ? 'log-page-number current' : 'quiet log-page-number')
      el.setAttribute('aria-label', `第 ${n} 页`)
      if (n === page) el.setAttribute('aria-current', 'page')
      controls.push(el)
      last = n
    }
    controls.push(step('下一页', page + 1, page >= pages, '下一页'))
    $('session-log-pager').replaceChildren(...controls)
  }
  // The selection count and the two bulk deletions, rebuilt whenever the selection changes.
  function renderSelection() {
    const boxes = [...$('session-log-list').querySelectorAll('input[type=checkbox]')]
    const all = $('session-log-select-all')
    all.checked = boxes.length > 0 && selected.size === boxes.length
    all.indeterminate = selected.size > 0 && selected.size < boxes.length
    all.disabled = !boxes.length
    $('session-log-selected').textContent = selected.size ? `已选 ${selected.size} 个会话（本页）` : '勾选会话后可批量删除；翻页或改筛选会清空勾选。'
    const remove = button(`删除所选${selected.size ? `（${selected.size}）` : ''}`, removeSelected, 'secondary danger')
    remove.disabled = !selected.size
    const range = button('删除筛选日期内的会话', removeRange, 'quiet danger')
    range.title = '按「创建于…至…」删除，只能和日期一起用'
    $('session-log-bulk-actions').replaceChildren(remove, range)
  }
  function row(item) {
    const tr = document.createElement('tr')
    const check = node('td', '', 'log-check')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.setAttribute('aria-label', `选择 ${titleOf(item)}`)
    box.onchange = () => {
      if (box.checked) selected.set(nameOf(item), item)
      else selected.delete(nameOf(item))
      tr.classList.toggle('selected', box.checked)
      renderSelection()
    }
    check.append(box)
    const name = node('td')
    name.append(node('strong', titleOf(item)), node('div', item.id, 'fingerprint muted log-id'),
      node('div', clientText(item.client) + (item.parentSession ? ' · 子代理会话' : ''), 'muted'))
    const key = node('td')
    if (item.keyFingerprint) keyLines(key, { key: item.key, fingerprint: item.keyFingerprint, label: item.keyLabel })
    else key.append(node('span', '未带 Key（匿名）', 'muted'))
    const usage = node('td')
    usage.append(node('div', item.models.join('、') || '—'))
    if (item.tokens.total) usage.append(node('div', `${item.tokens.total.toLocaleString('zh-CN')} token`, 'muted'))
    const events = node('td', `${item.eventCount} 条 · ${bytes(item.storedBytes)}${item.missingEvents ? ` · 缺 ${item.missingEvents} 条` : ''}`)
    const notes = node('td', '', 'log-annotation')
    if (item.tags.length) {
      const chips = node('div', '', 'log-tags')
      chips.append(...item.tags.map((tag) => node('span', tag, 'chip')))
      notes.append(chips)
    }
    if (item.note) {
      const note = node('div', item.note, 'log-note muted')
      note.title = item.note
      notes.append(note)
    }
    if (!item.tags.length && !item.note) notes.append(node('span', '—', 'muted'))
    const when = node('td', '', 'log-when')
    when.append(node('div', `创建 ${time(item.createdAt ?? item.firstReceivedAt)}`), node('div', `最近上传 ${time(item.lastReceivedAt)}`, 'muted'))
    const actions = node('div', '', 'row-actions'),
      cell = document.createElement('td')
    actions.append(
      button('查看', () => action(() => open(item.id, item.formatVersion))),
      button('备注', () => editNote(item), 'quiet'),
      button('删除', () => removeOne(item), 'quiet danger'),
    )
    cell.append(actions)
    tr.append(check, name, node('td', item.accountId || '—', item.accountId ? '' : 'muted'), key, usage, events, notes, when, cell)
    return tr
  }

  // ── Deletion ───────────────────────────────────────────────────────────────
  async function removeOne(item) {
    if (!(await confirmDelete(`删除这个会话的全部日志（${item.eventCount} 条事件）？`, [item]))) return
    action(async () => {
      await json(`/api/v1/session-logs/${encodeURIComponent(item.id)}/${item.formatVersion}`, undefined, 'DELETE')
      await loadList()
    }, { success: '会话日志已删除。' })
  }
  async function removeSelected() {
    const sessions = [...selected.values()]
    if (!sessions.length) return
    if (!(await confirmDelete(`删除勾选的 ${sessions.length} 个会话的全部日志？`, sessions))) return
    action(async () => {
      const result = await json('/api/v1/session-logs', { sessions: sessions.map(({ id, formatVersion }) => ({ id, formatVersion })) }, 'DELETE')
      await loadList()
      $('session-logs-note').textContent = `已删除 ${result.count} 个会话${result.missing ? `（${result.missing} 个已不存在）` : ''}。`
    }, { success: `已删除 ${sessions.length} 个会话。` })
  }
  // A date range deletes every account's sessions in it, so it is refused while any other filter
  // is applied: what the list shows and what would be deleted must be the same set.
  async function removeRange() {
    const { from, to, ...others } = filters
    if (!from || !to) return action(async () => { throw new Error('请先在「创建于…至…」选好起止日期并点「筛选」。') })
    if (Object.values(others).some(Boolean))
      return action(async () => { throw new Error('按日期删除会删掉该时段内所有账号的会话：请先清空其他筛选条件，或勾选后用「删除所选」。') })
    const span = `${new Date(Number(from)).toLocaleDateString('zh-CN')} 至 ${new Date(Number(to) - DAY).toLocaleDateString('zh-CN')}`
    if (!(await confirmDelete(`删除创建于 ${span} 的全部 ${total} 个会话日志？`, total <= items.length ? items : []))) return
    action(async () => {
      const result = await json('/api/v1/session-logs', { from: Number(from), to: Number(to) }, 'DELETE')
      await loadList()
      $('session-logs-note').textContent = `已删除 ${result.count} 个会话。`
    }, { success: '已按日期删除。' })
  }

  // ── Note and tags ──────────────────────────────────────────────────────────
  let editing = null
  function editNote(item) {
    editing = item
    $('session-log-note-session').textContent = `${titleOf(item)} · ${item.id}`
    $('session-log-note-text').value = item.note ?? ''
    $('session-log-note-tags').value = item.tags.join(', ')
    $('session-log-note-error').textContent = ''
    $('session-log-note-dialog').showModal()
  }
  $('session-log-note-cancel').onclick = () => $('session-log-note-dialog').close()
  $('session-log-note-form').onsubmit = (event) => {
    event.preventDefault()
    const item = editing
    if (!item) return
    const tags = $('session-log-note-tags').value.split(/[,，\n]/u).map((tag) => tag.trim()).filter(Boolean)
    action(async () => {
      await json(`/api/v1/session-logs/${encodeURIComponent(item.id)}/${item.formatVersion}`, { note: $('session-log-note-text').value, tags }, 'PATCH')
      $('session-log-note-dialog').close()
      await loadList()
    }, { success: '备注已保存。', errorTarget: 'session-log-note-error' })
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
  $('session-log-page-size').onchange = () => {
    pageSize = Number($('session-log-page-size').value)
    page = 1
    action(loadList)
  }
  $('session-log-select-all').onchange = () => {
    const on = $('session-log-select-all').checked
    for (const box of $('session-log-list').querySelectorAll('input[type=checkbox]')) {
      if (box.checked !== on) { box.checked = on; box.onchange() }
    }
    renderSelection()
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
      pageSize = 50
      items = []
      selected.clear()
      editing = null
      for (const id of ['session-log-confirm-dialog', 'session-log-note-dialog']) if ($(id).open) $(id).close()
      $('session-log-filters').reset()
      $('session-log-page-size').value = '50'
      $('session-log-list').replaceChildren()
      $('session-log-pager').replaceChildren()
      $('session-log-bulk-actions').replaceChildren()
    },
  }
}
