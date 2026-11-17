/**
 * The plugin page: status tabs with their counts, then the filter bar (search first, type, scope,
 * reset), then one server page shown as a table (default) or as cards, then the pager. 「全部」 holds
 * the product's built-in components (read-only) as well as the market's own plugins, so the tab
 * counts add up: 全部 = 内置 + 已上架 + 草稿 + 已下架. The access dialog (scope, organizations, Keys
 * and users, saved in one write) lives here too.
 */
const VIEW_KEY = 'tokenscowork-market-plugin-view'
const STATES = { builtin: ['内置', 'azure'], draft: ['草稿', 'secondary'], published: ['已上架', 'green'], archived: ['已下架', 'yellow'], deleted: ['回收站', 'red'] }
export const STATE_NAMES = Object.fromEntries(Object.entries(STATES).map(([state, [name]]) => [state, name]))

// The table/cards choice is a per-browser convenience: storage may be blocked, and then it is not kept.
function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'table'
  } catch {
    return 'table'
  }
}
function keepView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {}
}

export function pluginsView({ $, node, badge, rowActions, pager, json, action, reload, feedback, isSignedIn, organizations, keys, users, editor, icons }) {
  let stage = 'all',
    view = savedView(),
    items = [],
    page = 1,
    pageSize = 20,
    total = 0,
    counts = null,
    request = 0
  const builtin = (p) => p.category === 'builtin'
  const restricted = (p) => !builtin(p) && p.visibility === 'restricted'

  // ── Loading ────────────────────────────────────────────────────────────────
  const filters = () => {
    const query = $('plugin-search').value.trim(), kind = $('plugin-kind').value, visibility = $('visibility-filter').value
    return { stage, ...(kind !== 'all' ? { kind } : {}), ...(visibility !== 'all' ? { visibility } : {}), ...(query ? { q: query } : {}) }
  }
  // One page from the server. A slower answer to an older query never overwrites a newer one.
  async function load() {
    const ticket = ++request
    const result = await json('/api/v1/plugins?' + new URLSearchParams({ ...filters(), page: String(page), pageSize: String(pageSize) }))
    if (ticket !== request) return
    items = result.items
    total = result.total
    counts = result.counts
    // The server answers a page past the end with the last page; follow it.
    page = result.page
    pageSize = result.pageSize
    render()
  }
  const go = (target) => {
    page = target
    action(load)
  }
  // Every filter change starts again from page 1; paging keeps the filters.
  const refilter = () => {
    page = 1
    if (isSignedIn()) action(load)
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  // The plugin's icon where it has one (the same address the catalog and the docs center use),
  // else its first character; a broken image falls back to the character too.
  function avatar(p, size = '') {
    const box = node('span', '', 'avatar rounded' + (size ? ' ' + size : ''))
    const letter = () => box.replaceChildren(p.displayName.slice(0, 1))
    if (!p.icon) letter()
    else {
      const img = document.createElement('img')
      img.alt = ''
      img.src = p.icon
      img.onerror = letter
      box.append(img)
    }
    return box
  }
  const stateBadge = (p) => badge(...(STATES[p.state] || STATES.draft))
  function version(p) {
    const box = node('div')
    box.append(node('div', 'v' + (p.npm && p.state === 'published' ? p.npmLatestVersion || 'npm 暂无可用稳定版' : p.version)),
      node('div', builtin(p) ? `产品 ${p.productVersion} 内置` : p.npm ? '自动跟随 npm latest' : '固定版本', 'text-secondary small'))
    return box
  }
  function scope(p) {
    const box = node('div')
    if (builtin(p)) {
      box.append(badge('所有人', 'azure'), node('div', '随应用安装，不可卸载', 'text-secondary small'))
      return box
    }
    if (!restricted(p)) {
      box.append(badge('公开', 'green'), node('div', p.state === 'published' ? '所有人可见' : '上架后所有人可见', 'text-secondary small'))
      return box
    }
    const orgIds = p.access?.organizations ?? []
    box.append(badge('受限', 'yellow'),
      node('div', `${orgIds.length} 个组织 · ${p.access?.keys.length ?? 0} 个 Key · ${p.access?.users.length ?? 0} 个用户`, 'text-secondary small'))
    box.title = [...orgIds.map(organizations.label), ...(p.access?.users ?? []).map(users.label)].join('、')
    const disabled = orgIds.filter((id) => !organizations.byId(id)?.enabled).length
    if (disabled) box.append(node('div', `${disabled} 个组织已停用`, 'text-warning small'))
    return box
  }
  // One primary action per plugin, the rest under 「更多」.
  function actions(p) {
    if (builtin(p)) return node('span', '由产品清单管理', 'text-secondary small text-nowrap')
    const run = (operation) => () => editor().transition(p, operation, !restricted(p))
    if (p.state === 'deleted')
      return rowActions(p.displayName, { label: '恢复草稿', run: run('restore') }, [{ label: '彻底删除', run: run('purge'), danger: true }])
    const lifecycle = p.state === 'published'
      ? [{ label: '下架', run: run('archive') }]
      : [{ label: '上架', run: run('publish') }, { label: '移入回收站', run: run('trash'), danger: true }]
    return rowActions(p.displayName, { label: '编辑资料', run: () => editor().open(p) }, [
      { label: '访问范围', run: () => openAccess(p) },
      { label: '图标', run: () => icons.open(p, reload) },
      'divider',
      ...lifecycle,
    ])
  }
  function name(p) {
    const box = node('div', '', 'd-flex align-items-center gap-2 min-w-0')
    const text = node('div', '', 'min-w-0')
    text.append(node('div', p.displayName, 'fw-medium text-break'), node('div', p.package, 'text-secondary small text-break'))
    box.append(avatar(p), text)
    return box
  }
  function row(p) {
    const tr = document.createElement('tr')
    const cell = (...children) => {
      const td = document.createElement('td')
      td.append(...children)
      return td
    }
    tr.append(cell(name(p)), cell(version(p)), cell(stateBadge(p)), cell(scope(p)), cell(actions(p)))
    return tr
  }
  function card(p) {
    const box = node('div', '', 'card card-sm')
    const body = node('div', '', 'card-body')
    const head = node('div', '', 'd-flex align-items-start gap-2 mb-2')
    const title = node('div', '', 'min-w-0 flex-fill')
    title.append(node('div', p.displayName, 'fw-medium text-break'), node('div', p.package, 'text-secondary small text-break'))
    head.append(avatar(p), title, stateBadge(p))
    const summary = node('p', p.summary || '—', 'text-secondary small plugin-summary')
    if (p.summary) summary.title = p.summary
    body.append(head, summary, scope(p))
    const foot = node('div', '', 'card-footer d-flex align-items-center flex-wrap gap-2')
    const ver = version(p)
    ver.classList.add('me-auto', 'small')
    foot.append(ver, actions(p))
    box.append(body, foot)
    return box
  }
  function render() {
    for (const tab of document.querySelectorAll('[data-stage]')) {
      const current = tab.dataset.stage === stage
      tab.classList.toggle('active', current)
      if (current) tab.setAttribute('aria-current', 'true')
      else tab.removeAttribute('aria-current')
    }
    for (const count of document.querySelectorAll('[data-count]')) count.textContent = counts[count.dataset.count]
    // The type options carry their counts too, so 全部 = 市场插件 + 内置组件 reads off the screen.
    for (const option of $('plugin-kind').options)
      option.textContent = { all: '全部类型', market: `市场插件 (${counts.market})`, builtin: `内置组件 (${counts.builtin})` }[option.value]
    $('nav-plugins').textContent = counts.all
    for (const toggle of document.querySelectorAll('[data-plugin-view]')) {
      const current = toggle.dataset.pluginView === view
      toggle.classList.toggle('active', current)
      toggle.setAttribute('aria-pressed', String(current))
    }
    $('plugin-rows').replaceChildren(...(view === 'table' ? items.map(row) : []))
    $('plugin-cards').replaceChildren(...(view === 'cards' ? items.map(card) : []))
    $('plugin-table').hidden = view !== 'table' || !items.length
    $('plugin-cards').hidden = view !== 'cards' || !items.length
    $('plugin-empty').hidden = items.length > 0
    pager({ info: $('plugin-page'), list: $('plugin-pager'), size: $('plugin-page-size'), page, pageSize, total, unit: '个', go })
  }

  // ── Access dialog ──────────────────────────────────────────────────────────
  let accessPlugin = null,
    chosenOrgs = new Set(),
    chosenKeys = new Set(),
    chosenUsers = new Set(),
    accessBaseline = ''
  const chosenVisibility = () => document.querySelector('input[name="plugin-visibility"]:checked')?.value ?? 'restricted'
  const accessDraft = () => JSON.stringify([chosenVisibility(), [...chosenOrgs].sort(), [...chosenKeys].sort(), [...chosenUsers].sort()])
  function updateScope() {
    $('permission-summary').textContent = chosenVisibility() === 'public'
      ? '公开 · 所有人可见（下方授权保留，暂不起作用）'
      : chosenOrgs.size || chosenKeys.size || chosenUsers.size
        ? `受限 · ${chosenOrgs.size} 个组织 · ${chosenKeys.size} 个 Key · ${chosenUsers.size} 个用户`
        : '受限 · 暂无任何授权，无人可见'
    $('selected-org-count').textContent = `已选 ${chosenOrgs.size} 个`
    $('selected-key-count').textContent = `已选 ${chosenKeys.size} 个`
    $('selected-user-count').textContent = `已选 ${chosenUsers.size} 个`
  }
  function checklist(target, options, chosen, query, empty) {
    const search = query.trim().toLowerCase()
    const visible = options.filter((item) => item.text.toLowerCase().includes(search))
    $(target).replaceChildren(...visible.map((item) => {
      const label = node('label', '', 'list-group-item d-flex align-items-center gap-2'),
        box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 'form-check-input m-0'
      box.checked = chosen.has(item.value)
      box.onchange = () => {
        if (box.checked) chosen.add(item.value)
        else chosen.delete(item.value)
        updateScope()
      }
      label.append(box, node('span', item.text, 'text-break'))
      if (item.note) label.append(badge(item.note, 'yellow'))
      return label
    }))
    if (!visible.length) $(target).append(node('div', options.length ? '没有匹配项，已选项仍保留。' : empty, 'list-group-item text-secondary'))
  }
  const renderOrgOptions = () => checklist('organization-options',
    organizations.all().map((org) => ({ value: org.id, text: `${org.name} (#${org.id})`, note: org.enabled ? '' : '已停用' })),
    chosenOrgs, $('organization-search').value, '暂无组织。请先同步组织名录。')
  const renderKeyOptions = () => checklist('key-options',
    keys.all().map((key) => ({ value: key.fingerprint, text: [key.label, key.apiKey].filter(Boolean).join(' · ') || '未命名 Key' })),
    chosenKeys, $('key-search').value, '暂无登记的 Key。')
  const renderUserOptions = () => checklist('user-options',
    users.all().map((user) => ({ value: user.id, text: `${user.name} (#${user.id})` })),
    chosenUsers, $('user-search').value, '暂无用户。请先在「用户」页添加。')
  function openAccess(plugin) {
    accessPlugin = plugin
    chosenOrgs = new Set(plugin.access?.organizations ?? [])
    chosenKeys = new Set(plugin.access?.keys ?? [])
    chosenUsers = new Set(plugin.access?.users ?? [])
    $('plugin-title').textContent = `访问范围 · ${plugin.displayName}`
    $('plugin-package').textContent = plugin.package
    $('plugin-error').textContent = ''
    $('organization-search').value = ''
    $('key-search').value = ''
    $('user-search').value = ''
    for (const input of document.querySelectorAll('input[name="plugin-visibility"]')) input.checked = input.value === plugin.visibility
    renderOrgOptions()
    renderKeyOptions()
    renderUserOptions()
    updateScope()
    accessBaseline = accessDraft()
    $('plugin-dialog').showModal()
  }
  $('organization-search').oninput = renderOrgOptions
  $('key-search').oninput = renderKeyOptions
  $('user-search').oninput = renderUserOptions
  for (const input of document.querySelectorAll('input[name="plugin-visibility"]')) input.onchange = updateScope
  $('plugin-access-form').onsubmit = (event) => {
    event.preventDefault()
    const p = accessPlugin
    action(async () => {
      await json(`/api/v1/plugins/${encodeURIComponent(p.id)}/access`, {
        visibility: chosenVisibility(), organizations: [...chosenOrgs], keys: [...chosenKeys], users: [...chosenUsers], revision: p.revision,
      })
      $('plugin-dialog').close()
      await reload(`${p.displayName} 的访问范围已保存。`)
    }, { errorTarget: 'plugin-error' })
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  for (const tab of document.querySelectorAll('[data-stage]'))
    tab.onclick = () => {
      if (tab.dataset.stage === stage) return
      stage = tab.dataset.stage
      refilter()
    }
  // Typing searches on the server after a short pause. It stays out of action(), which would disable
  // the search box (and drop its focus) for every keystroke's request.
  let searchTimer
  $('plugin-search').oninput = () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      if (!isSignedIn()) return
      page = 1
      load().catch((error) => feedback(error.message, 'error'))
    }, 300)
  }
  $('plugin-kind').onchange = refilter
  $('visibility-filter').onchange = refilter
  $('plugin-page-size').onchange = () => {
    pageSize = Number($('plugin-page-size').value)
    refilter()
  }
  $('plugin-reset').onclick = () => {
    clearTimeout(searchTimer)
    stage = 'all'
    $('plugin-search').value = ''
    $('plugin-kind').value = 'all'
    $('visibility-filter').value = 'all'
    refilter()
  }
  for (const toggle of document.querySelectorAll('[data-plugin-view]'))
    toggle.onclick = () => {
      view = toggle.dataset.pluginView
      keepView(view)
      if (counts) render()
    }

  return {
    load,
    openAccess,
    accessDirty: () => $('plugin-dialog').open && accessDraft() !== accessBaseline,
    clear() {
      clearTimeout(searchTimer)
      items = []
      counts = null
      page = 1
      accessPlugin = null
      $('plugin-dialog').close()
      for (const id of ['plugin-rows', 'plugin-cards', 'plugin-pager', 'organization-options', 'key-options', 'user-options']) $(id).replaceChildren()
    },
  }
}
