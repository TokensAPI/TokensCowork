import { sessionLogDetailView, downloadSessionLog } from './market-session-log-detail.js'
import { TIME_PRESETS, classifySearch, sizeText, tokenText, relativeTime, shortKey, platformName, sessionRoute, parseSessionRoute } from './market-session-log-format.js'
import { latestOnly } from './market-ui.js'

/**
 * The session-log page: the index of sessions the desktop plugin uploaded, paged on the server.
 * One search box (account, session id or Key, told apart by classifySearch), the organization,
 * model and time pickers, 「更多筛选」 for the rest, and the applied filters as removable tags; the
 * totals of what the filters match; ticked-row and date-range deletion, each confirmed in a dialog
 * first; a note and tags per session; and the retention setting in its own dialog. One opened
 * session is shown by market-session-log-detail.js. Platform administrators only. Every byte shown
 * here is user content (files, commands, secrets), so it is only ever placed with textContent, and
 * each opened session and each download is recorded by the server.
 *
 * Nothing here locks the page. Reads (filters, pages, opening a session, copying) run through
 * read(), which disables nothing; only the latest list or session asked for is shown, so a late
 * answer never replaces a newer one, and while the list reloads only the table dims. A change
 * (deleting, a note, the retention setting) locks just the button or dialog it came from. An opened
 * session has its own address (#session-logs/<session>/<format version>): the browser's back
 * button, 「← 会话日志」 and Esc return to the list as it was left -- filters, page and scroll.
 *
 * The pager and the bulk buttons are rebuilt on every load rather than toggled, so no disabled
 * state left behind by an earlier operation survives a load.
 */
export function sessionLogsView({ $, node, button, badge, rowActions, pager, json, action, feedback, formatTime, organizations }) {
  const DAY = 24 * 60 * 60 * 1000
  let page = 1,
    pageSize = 50,
    filters = {},
    total = 0,
    items = [],
    retentionDays = null,
    listLoaded = false,
    // Where the list was scrolled when a session was opened from it.
    returnTo = null
  const listTurns = latestOnly(), detailTurns = latestOnly()
  // A read: reports errors like any operation but disables nothing.
  const read = (fn, options = {}) => action(fn, { ...options, lock: [] })
  // The ticked rows of the page on screen, by `${id}:${formatVersion}`. Cleared whenever the page
  // or the filters change, so a deletion only ever names rows the administrator can see.
  const selected = new Map()
  // Every model seen on a loaded page, offered as suggestions by the model picker.
  const models = new Set()
  const short = (value, length = 12) => (value ? value.slice(0, length) : '')
  const time = (value) => (value ? formatTime(value) : '—')
  const nameOf = (item) => `${item.id}:${item.formatVersion}`
  const titleOf = (item) => item.title || '未命名会话'
  const filtering = () => Object.values(filters).some(Boolean)
  // The Key in full when the server kept it (sealed); otherwise only its fingerprint is known.
  // The detail page shows it this way; the list shortens it (keyCell).
  function keyLines(target, { key, fingerprint, label }) {
    if (label) target.append(node('div', label))
    if (key) target.append(node('div', key, 'font-monospace small text-break user-select-all'))
    else target.append(node('div', `未保存原文 · 指纹 ${short(fingerprint, 16)}`, 'font-monospace small text-secondary'))
  }
  const clientText = (client) => [client.product, client.version, platformName(client.platform)].filter(Boolean).join(' ') || '—'
  async function copy(text) {
    if (!navigator.clipboard?.writeText) throw new Error('浏览器不允许复制，请打开会话详情复制。')
    await navigator.clipboard.writeText(text)
  }

  // ── Names and organizations ────────────────────────────────────────────────
  // Names, and the organization each account belongs to now, for the account ids the clients
  // report, asked once per id for a whole page and drawn in when they arrive, so the list never
  // waits on TokensAPI. An id nobody can name stays a bare id and an organization TokensAPI could
  // not tell stays 「—」; a failed request is forgotten so the next load asks again.
  const accountNames = new Map()
  const numericId = (value) => (/^[1-9][0-9]{0,15}$/u.test(value ?? '') ? value : '')
  function lookupNames(ids) {
    const missing = [...new Set(ids.map(numericId).filter((id) => id && !accountNames.has(id)))]
    if (!missing.length) return
    const request = json('/api/v1/users/names?ids=' + missing.join(','))
      .then((result) => new Map(result.items.map((user) => [String(user.id), user])))
      .catch(() => {
        for (const id of missing) accountNames.delete(id)
        return new Map()
      })
    for (const id of missing) accountNames.set(id, request.then((found) => found.get(id) ?? null))
  }
  // The name and organization for one reported id: { name, organization? } or null.
  function accountUser(id) {
    lookupNames([id])
    return accountNames.get(numericId(id)) ?? Promise.resolve(null)
  }
  // 「Runzhou」, 「#9」 (not registered here), 「无组织」, or null when TokensAPI could not tell.
  function organizationText(user) {
    const org = user?.organization
    if (org === undefined) return null
    return org ? org.name || `#${org.id}` : '无组织'
  }
  // The name on top and 「ID 535」 under it once the name arrives; the bare id until then.
  function accountCell(id) {
    const cell = node('td')
    if (!id) return cell.append(node('span', '—', 'text-secondary')), cell
    const top = node('div', id, 'text-break'), under = node('div', '', 'text-secondary small')
    cell.append(top, under)
    accountUser(id).then((user) => {
      if (!user) return
      top.textContent = user.name
      under.textContent = `ID ${id}`
      cell.title = '客户端上报的账号 ID，未核验；名称按此 ID 查得'
    })
    return cell
  }
  function organizationCell(id) {
    const cell = node('td', '—', 'text-break text-secondary')
    if (id) accountUser(id).then((user) => {
      const text = organizationText(user)
      if (!text) return
      cell.textContent = text
      cell.className = 'text-break' + (user.organization ? '' : ' text-secondary')
      cell.title = '按上报账号查到的当前归属，不一定是上传时的，未核验'
    })
    return cell
  }
  // The organization picker offers the organizations registered here (the API's organization=none
  // is kept for clean-ups but not offered); the choice survives a refill.
  function fillOrganizations() {
    const select = $('session-log-organization'), chosen = select.value
    const options = organizations.all().map((org) => {
      const option = node('option', `${org.name} (#${org.id})`)
      option.value = String(org.id)
      return option
    })
    select.replaceChildren(select.options[0], ...options)
    select.value = [...select.options].some((option) => option.value === chosen) ? chosen : ''
  }
  function fillModels() {
    $('session-log-models').replaceChildren(...[...models].sort().map((model) => {
      const option = document.createElement('option')
      option.value = model
      return option
    }))
  }
  const detail = sessionLogDetailView({ $, node, button, json, action, formatTime },
    { keyLines, clientText, accountUser, organizationText, onBack: leaveDetail, openSession: (id, formatVersion) => openSession(id, formatVersion, { push: true }) })

  // ── Confirmation ───────────────────────────────────────────────────────────
  // Every deletion asks here first: what goes, how many, and that it cannot be undone.
  function confirmDelete(text, sessions = []) {
    const dialog = $('session-log-confirm-dialog')
    $('session-log-confirm-text').textContent = text
    const shown = sessions.slice(0, 8).map((item) => node('li', `${titleOf(item)} · ${item.id}`))
    if (sessions.length > shown.length) shown.push(node('li', `…以及另外 ${sessions.length - shown.length} 个`, 'text-secondary'))
    $('session-log-confirm-list').replaceChildren(...shown)
    $('session-log-confirm-list').hidden = !shown.length
    return new Promise((resolve) => {
      dialog.returnValue = ''
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true })
      dialog.showModal()
    })
  }

  // ── Filters ────────────────────────────────────────────────────────────────
  // The search box fills exactly one of account / session / key; a preset time reaches back from
  // now, a custom one is the two dates under 「更多筛选」 (end date inclusive).
  function readFilters() {
    const day = (id, offset = 0) => {
      const value = $(id).value
      return value ? String(new Date(value + 'T00:00:00').getTime() + offset) : ''
    }
    const search = classifySearch($('session-log-search').value)
    const choice = $('session-log-time').value
    const preset = TIME_PRESETS[choice]
    return {
      account: search?.field === 'account' ? search.value : '', session: search?.field === 'session' ? search.value : '',
      key: search?.field === 'key' ? search.value : '', organization: $('session-log-organization').value,
      model: $('session-log-model').value.trim(), clientVersion: $('session-log-version').value.trim(), tag: $('session-log-tag').value.trim(),
      from: preset ? String(Date.now() - preset) : choice === 'custom' ? day('session-log-from') : '',
      to: choice === 'custom' ? day('session-log-to', DAY) : '',
    }
  }
  function apply() {
    filters = readFilters()
    page = 1
    read(loadList)
  }
  function showMore(open) {
    $('session-log-more-filters').hidden = !open
    $('session-log-more').setAttribute('aria-expanded', String(open))
    $('session-log-more').classList.toggle('active', open)
  }
  // The applied filters as tags; ✕ clears that one control and reloads.
  function renderChips() {
    const choice = $('session-log-time').value
    const select = $('session-log-organization')
    const searchLabel = { account: '账号', session: '会话', key: 'Key' }
    const day = (value) => new Date(Number(value)).toLocaleDateString('zh-CN')
    const chips = []
    const chip = (label, clear) => {
      const tag = node('span', '', 'tag')
      const close = button('', () => { clear(); apply() }, 'btn-close')
      close.setAttribute('aria-label', `去掉筛选 ${label}`)
      tag.append(node('span', label), close)
      chips.push(tag)
    }
    const search = classifySearch($('session-log-search').value)
    if (search && filters[search.field]) chip(`${searchLabel[search.field]}：${search.value}`, () => { $('session-log-search').value = '' })
    if (filters.organization) chip(`组织：${select.selectedOptions[0]?.textContent ?? filters.organization}`, () => { select.value = '' })
    if (filters.model) chip(`模型：${filters.model}`, () => { $('session-log-model').value = '' })
    if (filters.from || filters.to) {
      const text = choice === 'custom'
        ? `${filters.from ? day(filters.from) : '最早'} 至 ${filters.to ? day(Number(filters.to) - DAY) : '现在'}`
        : $('session-log-time').selectedOptions[0].textContent
      chip(`时间：${text}`, () => { $('session-log-time').value = ''; $('session-log-from').value = ''; $('session-log-to').value = '' })
    }
    if (filters.clientVersion) chip(`版本：${filters.clientVersion}`, () => { $('session-log-version').value = '' })
    if (filters.tag) chip(`标签：${filters.tag}`, () => { $('session-log-tag').value = '' })
    $('session-log-chips').replaceChildren(...(chips.length ? [node('span', '已筛选：', 'text-secondary small'), ...chips] : []))
    $('session-log-chips').hidden = !chips.length
  }

  // ── List ───────────────────────────────────────────────────────────────────
  function listLoading(on) {
    $('session-log-loading').hidden = !on
    if (on) $('session-log-table').setAttribute('aria-busy', 'true')
    else $('session-log-table').removeAttribute('aria-busy')
  }
  async function loadList() {
    const turn = listTurns.next()
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      page: String(page), pageSize: String(pageSize) })
    listLoading(true)
    let result
    try {
      result = await json('/api/v1/session-logs?' + query)
    } finally {
      if (listTurns.current(turn)) listLoading(false)
    }
    // A newer filter or page was asked for meanwhile; its answer is the one to show.
    if (!listTurns.current(turn)) return
    listLoaded = true
    total = result.total
    // Everything the filters match, not only this page.
    $('session-log-summary').textContent = `${filtering() ? '符合筛选的' : '共'} ${total} 个会话 · ${sizeText(result.storedBytes)}`
    // The server answers a page past the end with the last page; follow it.
    page = result.page
    pageSize = result.pageSize
    items = result.items
    selected.clear()
    for (const item of items) for (const model of item.models) models.add(model)
    fillModels()
    lookupNames(items.map((item) => item.accountId))
    $('session-log-list').replaceChildren(...items.map(row))
    $('session-log-empty').hidden = items.length > 0
    $('session-log-empty').firstElementChild.textContent = filtering() ? '没有符合条件的会话' : '暂无会话日志'
    $('session-log-key-note').hidden = result.keyDisplayReady
    pager({ info: $('session-log-page'), list: $('session-log-pager'), size: $('session-log-page-size'), page, pageSize, total, unit: '个会话', go: goTo })
    renderChips()
    renderSelection()
  }
  function goTo(target) {
    page = target
    read(loadList)
  }
  // The bulk area, rebuilt whenever the selection changes: 「已选 N 个 · 删除所选」 only while rows are
  // ticked, and the 「⋯」 menu with deletion by date always.
  function renderSelection() {
    const boxes = [...$('session-log-list').querySelectorAll('input[type=checkbox]')]
    const all = $('session-log-select-all')
    all.checked = boxes.length > 0 && selected.size === boxes.length
    all.indeterminate = selected.size > 0 && selected.size < boxes.length
    all.disabled = !boxes.length
    const parts = []
    if (selected.size) {
      const remove = button('删除所选', () => removeSelected(remove), 'btn btn-outline-danger btn-sm')
      parts.push(node('span', `已选 ${selected.size} 个`, 'text-secondary'), remove)
    }
    const more = menu('会话日志', [{ label: '按日期删除…', danger: true, run: () => removeRange(more.querySelector('.dropdown-toggle')) }])
    parts.push(more)
    $('session-log-bulk-actions').replaceChildren(...parts)
  }
  // The console's row menu, shown as 「⋯」.
  function menu(name, entries) {
    const box = rowActions(name, null, entries)
    const toggle = box.querySelector('.dropdown-toggle')
    toggle.textContent = '⋯'
    toggle.className = 'btn btn-ghost-secondary btn-sm px-2'
    toggle.title = '更多操作'
    return box
  }
  function sessionCell(item) {
    const cell = node('td', '', 'log-session')
    const title = button(titleOf(item), () => showSession(item), 'btn btn-link p-0 text-reset fw-medium text-start text-break')
    const meta = [item.client.version, platformName(item.client.platform)].filter(Boolean).join(' · ') || '—'
    cell.append(title, node('div', meta + (item.parentSession ? ' · 子代理会话' : ''), 'text-secondary small'))
    return cell
  }
  // The Key's note when it has one, otherwise the Key shortened; 「复制」 copies the whole Key.
  function keyCell(item) {
    const cell = node('td', '', 'text-nowrap')
    if (!item.keyFingerprint) return cell.append(node('span', '匿名', 'text-secondary')), cell
    if (item.keyLabel) cell.append(badge(item.keyLabel))
    else if (item.key) cell.append(node('code', shortKey(item.key)))
    else cell.append(node('code', `指纹 ${short(item.keyFingerprint, 8)}`, 'text-secondary'))
    cell.title = item.keyLabel && item.key ? shortKey(item.key) : ''
    if (item.key) cell.append(button('复制', () => read(() => copy(item.key), { success: 'Key 已复制。' }), 'btn btn-link btn-sm p-0 ms-2'))
    return cell
  }
  function modelCell(item) {
    const cell = node('td', '', 'text-nowrap')
    if (!item.models.length) return cell.append(node('span', '—', 'text-secondary')), cell
    cell.append(node('span', item.models[0]))
    if (item.models.length > 1) {
      const more = badge(`+${item.models.length - 1}`)
      more.classList.add('ms-1')
      cell.append(more)
      cell.title = item.models.join('、')
    }
    return cell
  }
  function tagsCell(item) {
    const cell = node('td', '', 'log-annotation')
    if (item.tags.length) {
      const chips = node('div', '', 'badges-list')
      chips.append(...item.tags.map((tag) => badge(tag)))
      cell.append(chips)
    }
    if (item.note) {
      const note = node('div', item.note, 'text-secondary small text-truncate')
      note.title = item.note
      cell.append(note)
    }
    if (!item.tags.length && !item.note) cell.append(node('span', '—', 'text-secondary'))
    return cell
  }
  function row(item) {
    const tr = document.createElement('tr')
    tr.className = 'cursor-pointer'
    const check = node('td')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'form-check-input m-0 align-middle'
    box.setAttribute('aria-label', `选择 ${titleOf(item)}`)
    box.onchange = () => {
      if (box.checked) selected.set(nameOf(item), item)
      else selected.delete(nameOf(item))
      tr.classList.toggle('table-active', box.checked)
      renderSelection()
    }
    check.append(box)
    const events = node('td', '', 'text-end text-nowrap')
    events.append(node('div', `${item.eventCount} 条 · ${sizeText(item.storedBytes)}`))
    if (item.missingEvents) events.append(node('div', `缺 ${item.missingEvents} 条`, 'text-warning small'))
    const when = node('td', relativeTime(item.lastReceivedAt), 'text-nowrap')
    when.title = `创建 ${time(item.createdAt ?? item.firstReceivedAt)} · 最近上传 ${time(item.lastReceivedAt)}`
    const actions = node('td')
    // A change started from the menu locks the menu's own button while it runs.
    const rowMenu = menu(titleOf(item), [
      { label: '查看', run: () => showSession(item) },
      { label: '下载 JSON', run: () => action(() => downloadSessionLog(item.id, item.formatVersion, 'json'), { success: 'JSON 已下载，已写入操作记录。', lock: rowMenu.querySelector('.dropdown-toggle') }) },
      { label: '编辑备注与标签', run: () => editNote(item) },
      'divider',
      { label: '删除', danger: true, run: () => removeOne(item, rowMenu.querySelector('.dropdown-toggle')) },
    ])
    actions.append(rowMenu)
    tr.append(check, sessionCell(item), accountCell(item.accountId), organizationCell(item.accountId), keyCell(item), modelCell(item),
      node('td', tokenText(item.tokens.total), 'text-end text-nowrap'), events, tagsCell(item), when, actions)
    // The whole row opens the session, except where a click means something of its own.
    tr.onclick = (event) => {
      if (event.target.closest('input, button, a, label, .dropdown-menu') || getSelection()?.toString()) return
      showSession(item)
    }
    return tr
  }

  // ── Deletion ───────────────────────────────────────────────────────────────
  // Each deletion locks only the control it was started from (`lock`), which also stops a second
  // click from sending it twice.
  async function removeOne(item, lock) {
    if (!(await confirmDelete(`删除这个会话的全部日志（${item.eventCount} 条事件）？`, [item]))) return
    action(async () => {
      await json(`/api/v1/session-logs/${encodeURIComponent(item.id)}/${item.formatVersion}`, undefined, 'DELETE')
      await loadList()
    }, { success: '会话日志已删除。', lock })
  }
  async function removeSelected(lock) {
    const sessions = [...selected.values()]
    if (!sessions.length) return
    if (!(await confirmDelete(`删除勾选的 ${sessions.length} 个会话的全部日志？`, sessions))) return
    action(async () => {
      const result = await json('/api/v1/session-logs', { sessions: sessions.map(({ id, formatVersion }) => ({ id, formatVersion })) }, 'DELETE')
      await loadList()
      feedback(`已删除 ${result.count} 个会话${result.missing ? `（${result.missing} 个已不存在）` : ''}。`)
    }, { lock })
  }
  // A date range deletes every account's sessions in it, so it needs both dates of a custom range
  // and is refused while any other filter is applied: what the list shows and what would be deleted
  // must be the same set.
  async function removeRange(lock) {
    const { from, to, ...others } = filters
    if (!from || !to || $('session-log-time').value !== 'custom')
      return read(async () => { throw new Error('请先在「时间」选「自定义」，在「更多筛选」填好起止日期并应用筛选。') })
    if (Object.values(others).some(Boolean))
      return read(async () => { throw new Error('按日期删除会删掉该时段内所有账号的会话：请先清空其他筛选条件，或勾选后用「删除所选」。') })
    const span = `${new Date(Number(from)).toLocaleDateString('zh-CN')} 至 ${new Date(Number(to) - DAY).toLocaleDateString('zh-CN')}`
    if (!(await confirmDelete(`删除创建于 ${span} 的全部 ${total} 个会话日志？`, total <= items.length ? items : []))) return
    action(async () => {
      const result = await json('/api/v1/session-logs', { from: Number(from), to: Number(to) }, 'DELETE')
      await loadList()
      feedback(`已按日期删除 ${result.count} 个会话。`)
    }, { lock })
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
    }, { success: '备注已保存。', errorTarget: 'session-log-note-error', lock: $('session-log-note-form') })
  }

  // ── Retention setting ──────────────────────────────────────────────────────
  function showRetention() {
    $('session-log-settings-open').textContent = `设置 · 保留天数：${retentionDays ? `${retentionDays} 天` : '永久'}`
  }
  $('session-log-settings-open').onclick = () => {
    $('session-log-retention').value = retentionDays ?? ''
    $('session-log-settings-error').textContent = ''
    $('session-log-settings-dialog').showModal()
  }
  $('session-log-settings-cancel').onclick = () => $('session-log-settings-dialog').close()
  $('session-log-settings').onsubmit = (event) => {
    event.preventDefault()
    const value = $('session-log-retention').value.trim()
    action(async () => {
      const saved = await json('/api/v1/session-logs/settings', { retentionDays: value ? Number(value) : null })
      retentionDays = saved.retentionDays ?? null
      showRetention()
      $('session-log-settings-dialog').close()
    }, { success: value ? `保留期已设为 ${value} 天。` : '已改为永久保留。', errorTarget: 'session-log-settings-error', lock: $('session-log-settings') })
  }

  // ── Detail ─────────────────────────────────────────────────────────────────
  // Opening a session from the list remembers where the list was and gives the session its own
  // history entry, so the browser's back button returns to the list. `depth` counts the sessions
  // opened in a row (a parent, then a child), so 「← 会话日志」 goes back past all of them at once.
  const showSession = (item) => read(() => openSession(item.id, item.formatVersion, { push: true }))
  async function openSession(id, formatVersion, { push }) {
    const turn = detailTurns.next()
    const fromList = !$('session-log-browser').hidden
    const scroll = { y: window.scrollY, x: $('session-log-table').scrollLeft }
    if (!(await detail.open(id, formatVersion, () => detailTurns.current(turn)))) return
    if (fromList) returnTo = scroll
    const route = '#' + sessionRoute(id, formatVersion)
    if (push && location.hash !== route) history.pushState({ sessionLogDepth: (history.state?.sessionLogDepth ?? 0) + 1 }, '', route)
    $('session-log-browser').hidden = true
    $('session-log-detail').hidden = false
    $('session-log-detail').scrollIntoView?.({ block: 'start' })
  }
  // The list exactly as it was left; it is not asked for again.
  function back() {
    detailTurns.next()
    detail.close()
    $('session-log-detail').hidden = true
    $('session-log-browser').hidden = false
    if (returnTo) {
      window.scrollTo(0, returnTo.y)
      $('session-log-table').scrollLeft = returnTo.x
    }
  }
  // 「← 会话日志」 and Esc: through history when the sessions were opened here, so the back button
  // stays in step; a session opened from a link has no list behind it, so the list is loaded.
  function leaveDetail() {
    const depth = history.state?.sessionLogDepth ?? 0
    if (depth > 0) return history.go(-depth)
    history.replaceState(null, '', '#session-logs')
    back()
    if (!listLoaded) read(refresh)
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || $('session-log-detail').hidden || $('session-logs-panel').hidden) return
    if (document.querySelector('dialog[open], .dropdown-menu.show') || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
    leaveDetail()
  })

  // ── Controls ───────────────────────────────────────────────────────────────
  // Text fields apply on Enter (the form's submit); pickers apply as soon as they change.
  $('session-log-filters').onsubmit = (event) => {
    event.preventDefault()
    apply()
  }
  $('session-log-search').addEventListener('search', () => { if (!$('session-log-search').value) apply() })
  for (const id of ['session-log-organization', 'session-log-model']) $(id).onchange = apply
  $('session-log-time').onchange = () => {
    if ($('session-log-time').value === 'custom') return showMore(true)
    $('session-log-from').value = ''
    $('session-log-to').value = ''
    apply()
  }
  // Picking a date is a custom range, applied once both ends or either end is set.
  for (const id of ['session-log-from', 'session-log-to']) $(id).onchange = () => {
    $('session-log-time').value = 'custom'
    apply()
  }
  $('session-log-more').onclick = () => showMore($('session-log-more-filters').hidden)
  $('session-log-reset').onclick = () => {
    $('session-log-filters').reset()
    filters = {}
    page = 1
    read(loadList)
  }
  $('session-log-page-size').onchange = () => {
    pageSize = Number($('session-log-page-size').value)
    page = 1
    read(loadList)
  }
  $('session-log-select-all').onchange = () => {
    const on = $('session-log-select-all').checked
    for (const box of $('session-log-list').querySelectorAll('input[type=checkbox]')) {
      if (box.checked !== on) { box.checked = on; box.onchange() }
    }
    renderSelection()
  }

  // The organizations, the retention setting and the list, as the page is opened.
  async function refresh() {
    fillOrganizations()
    const settings = await json('/api/v1/session-logs/settings')
    retentionDays = settings.retentionDays ?? null
    showRetention()
    await loadList()
  }

  return {
    // Loaded when the page is opened, not with the rest of the console: it is the one page that
    // may be unconfigured, and it should not keep the others from loading. The address decides:
    // a session's address opens it (a link works on its own); a malformed one falls back to the
    // list; coming back from a session shows the list as it was left, without asking again.
    async show() {
      const target = parseSessionRoute(location.hash)
      if (target) {
        if (!detail.shows(target.id, target.formatVersion)) await openSession(target.id, target.formatVersion, { push: false })
        return
      }
      if (location.hash.startsWith('#session-logs/')) history.replaceState(null, '', '#session-logs')
      if (detail.isOpen() || !$('session-log-detail').hidden) {
        back()
        if (listLoaded) return
      }
      await refresh()
    },
    clear() {
      back()
      returnTo = null
      listLoaded = false
      listTurns.next()
      listLoading(false)
      filters = {}
      page = 1
      pageSize = 50
      items = []
      retentionDays = null
      selected.clear()
      models.clear()
      editing = null
      for (const id of ['session-log-confirm-dialog', 'session-log-note-dialog', 'session-log-settings-dialog']) if ($(id).open) $(id).close()
      $('session-log-filters').reset()
      showMore(false)
      $('session-log-page-size').value = '50'
      $('session-log-list').replaceChildren()
      $('session-log-pager').replaceChildren()
      $('session-log-bulk-actions').replaceChildren()
      $('session-log-chips').replaceChildren()
      $('session-log-chips').hidden = true
      $('session-log-models').replaceChildren()
      showRetention()
    },
  }
}
