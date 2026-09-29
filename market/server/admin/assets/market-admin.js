import { catalogEditor } from './market-catalog-editor.js'
import { organizationsView } from './market-organizations.js'
import { keysView } from './market-keys.js'
import { usersView } from './market-users.js'
import { grantsDialog } from './market-grants.js'
import { marketRequest } from './market-api.js'
import { mergePlugins, filterPlugins } from './market-model.js'

// The console shell: sign-in, navigation, the plugin page with its access dialog, and the
// activity log. Organizations, Keys, users and the per-subject grant dialog live in their own
// modules and share these helpers.
const $ = (id) => document.getElementById(id)
const node = (tag, text = '', className = '') => {
  const el = document.createElement(tag)
  el.textContent = text
  el.className = className
  return el
}
const button = (label, handler, className = 'secondary') => {
  const el = node('button', label, className)
  el.type = 'button'
  el.onclick = () => {
    if (!busy) handler()
  }
  return el
}
const formatTime = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const views = {
  plugins: ['插件', '管理插件资料、上架状态和访问范围。'],
  organizations: ['组织', '同步 TokensAPI 组织，查看每个组织能用的插件。'],
  keys: ['Key', '登记单独授权用的 Key，给它单独授权插件。'],
  users: ['用户', '给 TokensAPI 用户单独授权插件，对该用户名下所有 Key 生效。'],
  activity: ['操作记录', '最近的插件、访问范围和组织变更。'],
}
let session = null,
  plugins = [],
  audit = [],
  busy = false,
  stage = 'all',
  currentView = 'plugins'
const platform = () => session?.role === 'platform'
const allowedViews = () => (platform() ? Object.keys(views) : ['organizations'])
const pluginName = (id) => plugins.find((p) => p.id === id)?.displayName || id

let feedbackTimer
function feedback(message = '', kind = 'success') {
  clearTimeout(feedbackTimer)
  const toast = $('message')
  toast.hidePopover?.()
  toast.replaceChildren()
  toast.hidden = !message
  if (!message) return
  toast.dataset.kind = kind
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  const close = node('button', '×', 'toast-close')
  close.type = 'button'
  close.setAttribute('aria-label', '关闭提示')
  close.onclick = () => feedback()
  toast.append(node('span', kind === 'error' ? '!' : '✓', 'toast-icon'), node('span', message, 'toast-text'), close)
  toast.showPopover?.()
  if (kind !== 'error') feedbackTimer = setTimeout(() => feedback(), 5000)
}
async function json(path, data, method) {
  try {
    return await marketRequest(path, data, method)
  } catch (error) {
    if (error.status === 401 && path !== '/api/v1/session') {
      lock()
      error.message = '登录已过期，请重新登录。'
    }
    throw error
  }
}
async function action(fn, { errorTarget, success, silent401 = false } = {}) {
  if (busy) return
  busy = true
  const controls = new Map([...document.querySelectorAll('button,input,textarea,select')].map((el) => [el, el.disabled]))
  controls.forEach((_, el) => {
    el.disabled = true
  })
  document.body.setAttribute('aria-busy', 'true')
  if (errorTarget) $(errorTarget).textContent = ''
  feedback()
  try {
    await fn()
    if (success) feedback(success)
  } catch (error) {
    if (!(silent401 && error.status === 401)) {
      feedback(error.message + (error.retryAfter ? `（约 ${error.retryAfter} 秒后可重试）` : ''), 'error')
      if (errorTarget && !document.body.classList.contains('signed-out')) $(errorTarget).textContent = error.message
    }
  } finally {
    controls.forEach((disabled, el) => {
      el.disabled = disabled
    })
    busy = false
    document.body.removeAttribute('aria-busy')
  }
}
async function reload(message) {
  try {
    await load()
    feedback(message)
  } catch (error) {
    feedback(`${message} 但页面刷新失败：${error.message} 请刷新核对，无需重复保存。`, 'error')
  }
}
const grants = grantsDialog({ $, node, json, action, reload, plugins: () => plugins })
const shared = { $, node, button, json, action, reload, formatTime, pluginName, grants, isBusy: () => busy }
const organizations = organizationsView(shared)
const keys = keysView(shared)
const users = usersView(shared)

function navigate(view) {
  const open = allowedViews()
  currentView = open.includes(view) ? view : open[0]
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== currentView
  for (const link of document.querySelectorAll('[data-view]')) {
    link.hidden = !open.includes(link.dataset.view)
    if (link.dataset.view === currentView) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  const [title, description] = platform() || currentView !== 'organizations'
    ? views[currentView]
    : ['我的组织', '平台提供给本组织的插件；受限插件可以对本组织成员关闭。']
  $('page-title').textContent = title
  $('page-description').textContent = description
}

// ── Plugins ──────────────────────────────────────────────────────────────────
const builtin = (p) => p.category === 'builtin'
const restricted = (p) => !builtin(p) && p.visibility === 'restricted'
const STATES = { builtin: '随应用更新', draft: '草稿', published: '已上架', archived: '已下架', deleted: '回收站' }
function renderPlugins() {
  const visible = filterPlugins(plugins, { stage, query: $('plugin-search').value, visibility: $('visibility-filter').value })
  $('plugin-grid').replaceChildren(...visible.map((p) => {
    const card = node('article', '', 'plugin-card'),
      top = node('div', '', 'card-top'),
      name = node('div', '', 'card-name')
    name.append(node('h2', p.displayName), node('div', p.package, 'package'))
    top.append(
      node('div', p.displayName.slice(0, 1), 'plugin-icon'),
      name,
      node('span', builtin(p) ? '内置' : restricted(p) ? '受限' : '公开', 'badge' + (builtin(p) ? ' builtin' : restricted(p) ? ' restricted' : '')),
    )
    const summary = node('div', '', 'grant-summary')
    summary.append(node('span', STATES[p.state] || '草稿', 'chip'))
    if (builtin(p)) summary.append(node('span', '无需安装 · 不支持卸载', 'chip'))
    else if (!restricted(p)) summary.append(node('span', p.state === 'published' ? '所有人可见' : '上架后所有人可见', 'chip'))
    else {
      const orgIds = p.access?.organizations ?? []
      summary.append(node('span', `${orgIds.length} 个组织`, 'chip'), node('span', `${p.access?.keys.length ?? 0} 个 Key`, 'chip'),
        node('span', `${p.access?.users.length ?? 0} 个用户`, 'chip'))
      summary.title = [...orgIds.map(organizations.label), ...(p.access?.users ?? []).map(users.label)].join('、')
      const disabled = orgIds.filter((id) => !organizations.byId(id)?.enabled).length
      if (disabled) summary.append(node('span', `${disabled} 个组织已停用`, 'chip disabled'))
    }
    const bottom = node('div', '', 'card-bottom')
    bottom.append(node('span',
      'v' + (p.npm && p.state === 'published' ? p.npmLatestVersion || 'npm 暂无可用稳定版' : p.version) + ' · ' +
        (builtin(p) ? `产品 ${p.productVersion} 内置版本` : p.npm ? '自动跟随 npm latest' : '固定版本'),
      'version'))
    const actions = node('div', '', 'catalog-actions')
    if (builtin(p)) actions.append(node('span', '由产品清单管理', 'muted'))
    else if (p.state === 'deleted')
      actions.append(
        button('恢复草稿', () => editor.transition(p, 'restore', !restricted(p))),
        button('彻底删除', () => editor.transition(p, 'purge', !restricted(p)), 'danger'),
      )
    else {
      actions.append(button('编辑资料', () => editor.open(p), 'quiet'), button('访问范围', () => openAccess(p)))
      if (p.state === 'published') actions.append(button('下架', () => editor.transition(p, 'archive', !restricted(p)), 'quiet'))
      else actions.append(
        button('上架', () => editor.transition(p, 'publish', !restricted(p))),
        button('移入回收站', () => editor.transition(p, 'trash', !restricted(p)), 'quiet danger'),
      )
    }
    for (const control of actions.children) control.setAttribute('aria-label', p.displayName + ' ' + control.textContent)
    bottom.append(actions)
    card.append(top, node('p', p.summary, 'description'), summary, bottom)
    return card
  }))
  const inScope = plugins.filter((p) => (stage === 'deleted' ? p.state === 'deleted' : p.state !== 'deleted'))
  $('empty').hidden = visible.length > 0
  $('plugin-result-count').textContent = `显示 ${visible.length} / ${inScope.length} 项${stage === 'deleted' ? '（回收站）' : '（不含回收站）'}`
  const count = (state) => plugins.filter((p) => p.state === state).length
  $('stat-total').textContent = plugins.filter((p) => p.state !== 'deleted').length
  $('stat-optional').textContent = count('published')
  $('stat-restricted').textContent = count('archived')
  $('stat-builtin').textContent = count('draft')
  $('nav-plugins').textContent = plugins.filter((p) => p.state !== 'deleted').length
}

// ── Access dialog: scope, organizations, Keys and users, saved in one write ──
let accessPlugin = null,
  chosenOrgs = new Set(),
  chosenKeys = new Set(),
  chosenUsers = new Set(),
  accessBaseline = ''
const chosenVisibility = () => document.querySelector('input[name="plugin-visibility"]:checked')?.value ?? 'restricted'
const accessDraft = () => JSON.stringify([chosenVisibility(), [...chosenOrgs].sort(), [...chosenKeys].sort(), [...chosenUsers].sort()])
const accessDirty = () => $('plugin-dialog').open && accessDraft() !== accessBaseline
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
function checklist(target, items, chosen, query, empty) {
  const search = query.trim().toLowerCase()
  const visible = items.filter((item) => item.text.toLowerCase().includes(search))
  $(target).replaceChildren(...visible.map((item) => {
    const label = node('label'),
      box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = chosen.has(item.value)
    box.onchange = () => {
      if (box.checked) chosen.add(item.value)
      else chosen.delete(item.value)
      updateScope()
    }
    label.append(box, document.createTextNode(' ' + item.text))
    if (item.note) label.append(node('span', item.note, 'muted'))
    return label
  }))
  if (!visible.length) $(target).append(node('p', items.length ? '没有匹配项，已选项仍保留。' : empty, 'muted'))
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
  $('plugin-title').textContent = plugin.displayName
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

// Closing a dialog with unsaved edits asks first.
let pendingClose = null
function closeDialog(id) {
  if (busy) return false
  if (id === 'catalog-dialog' ? editor.dirty() : id === 'plugin-dialog' && accessDirty()) {
    pendingClose = id
    $('discard-dialog').showModal()
    $('keep-editing').focus()
    return false
  }
  $(id).close()
  return true
}
$('cancel-plugin').onclick = () => closeDialog('plugin-dialog')
$('plugin-dialog').addEventListener('cancel', (event) => {
  event.preventDefault()
  closeDialog('plugin-dialog')
})
$('keep-editing').onclick = () => $('discard-dialog').close()
$('discard-changes').onclick = () => {
  const target = pendingClose
  $('discard-dialog').close()
  if (target) $(target).close()
  pendingClose = null
}
window.addEventListener('beforeunload', (event) => {
  if (accessDirty() || editor.dirty()) {
    event.preventDefault()
    event.returnValue = ''
  }
})

// ── Activity ─────────────────────────────────────────────────────────────────
const ACTIONS = {
  'catalog.created': '新建插件',
  'catalog.edit': '编辑插件',
  'catalog.publish': '上架插件',
  'catalog.archive': '下架插件',
  'catalog.trash': '移入回收站',
  'catalog.restore': '恢复插件',
  'catalog.purge': '彻底删除插件',
  'plugin.access.updated': '更新访问范围',
  'organization.updated': '维护组织',
  'organizations.synced': '同步组织名录',
  'tenant.plugin.updated': '组织插件设置',
  'key.added': '登记 Key',
  'key.updated': '修改 Key 备注',
  'key.deleted': '删除 Key',
  'grants.updated': '配置插件授权',
  'user.updated': '维护用户',
  'user.deleted': '移除用户',
}
function actorText(actor) {
  if (actor?.kind === 'tenant') return `组织管理员 · 用户 ${actor.id}${actor.organizationId ? ` · 组织 #${actor.organizationId}` : ''}`
  if (actor?.kind === 'root') return actor.id === 'token' ? '平台管理员 · 口令' : '平台管理员 · 会话'
  return '历史记录'
}
function targetText(event) {
  if (event.action === 'tenant.plugin.updated') {
    const [org, plugin] = event.target.split(':')
    return `${organizations.label(Number(org))} · ${pluginName(plugin)}`
  }
  if (event.action === 'grants.updated') {
    const [kind, subject] = event.target.split(':')
    return kind === 'org' ? organizations.label(Number(subject)) : kind === 'key' ? keys.label(subject) : users.label(subject)
  }
  if (event.action.startsWith('key.')) return keys.label(event.target)
  if (event.action.startsWith('user.')) return users.label(event.target)
  if (event.action === 'organization.updated') return organizations.label(Number(event.target))
  if (event.action === 'organizations.synced') return ''
  return pluginName(event.target)
}
function renderActivity() {
  $('activity-list').replaceChildren(...audit.map((event) => {
    const row = node('div', '', 'activity-row'),
      detail = node('div', '', 'activity-text'),
      d = event.details || {},
      facts = []
    if (d.state) facts.push({ ...STATES, purged: '已彻底删除' }[d.state] || d.state)
    if (d.visibility) facts.push(d.visibility === 'public' ? '公开' : '受限')
    if (d.organizationCount != null) facts.push(`${d.organizationCount} 个组织`)
    if (d.keyCount != null) facts.push(`${d.keyCount} 个 Key`)
    if (d.userCount != null) facts.push(`${d.userCount} 个用户`)
    if (d.pluginCount != null) facts.push(`共 ${d.pluginCount} 个插件（新增 ${d.added}，撤销 ${d.removed}）`)
    if (d.count != null) facts.push(`${d.count} 个组织`)
    if (d.grantCount != null) facts.push(`移除 ${d.grantCount} 项授权`)
    if (typeof d.enabled === 'boolean') facts.push(d.enabled ? '开启' : '关闭')
    if (d.memberCount != null) facts.push(d.memberCount ? `指定 ${d.memberCount} 位成员可见` : '全员可见')
    const target = targetText(event)
    detail.append(node('strong', `${ACTIONS[event.action] || '管理变更'}${target ? ' · ' + target : ''}`), node('p', facts.join(' · ') || '已保存', 'muted'))
    row.append(node('span', '✓', 'activity-mark'), detail, node('span', actorText(event.actor), 'activity-actor muted'), node('time', formatTime(event.createdAt), 'muted'))
    return row
  }))
  $('activity-empty').hidden = audit.length > 0
}

// ── Session ──────────────────────────────────────────────────────────────────
function showEnvironment() {
  const env = session.environment
  const label = platform()
    ? env.preview ? '生产快照 · 本地' : { production: '正式环境', development: '测试环境' }[env.name] || '未配置环境'
    : `${session.organizationName || '组织 #' + session.organizationId} · 组织管理员`
  $('environment-badge').textContent = label
  $('sidebar-environment').textContent = label
  $('environment-badge').title = platform() ? env.origin || '尚未配置 TokensAPI 地址' : ''
  $('nav-org-label').textContent = platform() ? '组织' : '我的组织'
  // An organization administrator has exactly one organization; a count means nothing there.
  $('nav-orgs').hidden = !platform()
  $('api-docs-link').hidden = !platform()
}
async function load() {
  const next = await json('/api/v1/session')
  if (!next.authenticated) throw Object.assign(new Error('请先登录。'), { status: 401 })
  session = next
  showEnvironment()
  // An organization administrator may read its own organization and nothing else.
  if (!platform()) {
    await organizations.lockTo(session.organizationId)
  } else {
    const [catalog, orgList, keyList, userList, log] = await Promise.all([
      json('/api/v1/plugins'), json('/api/v1/organizations'), json('/api/v1/keys'), json('/api/v1/users'), json('/api/v1/audit'),
    ])
    plugins = mergePlugins(catalog)
    audit = log.items
    organizations.set(orgList)
    keys.set(keyList)
    users.set(userList)
    const privateRegistry = $('catalog-registry').querySelector('option[value="tokenscowork"]')
    if (privateRegistry) privateRegistry.disabled = privateRegistry.hidden = !session.environment.privateRegistryReady
    renderPlugins()
    renderActivity()
    await organizations.refreshDetail()
  }
  $('last-refresh').textContent = `更新于 ${formatTime(Date.now())}`
}
function lock() {
  document.body.classList.add('signed-out')
  editor.clear()
  organizations.clear()
  keys.clear()
  users.clear()
  grants.clear()
  session = null
  plugins = []
  audit = []
  accessPlugin = null
  for (const id of ['plugin-dialog', 'discard-dialog']) $(id).close()
  pendingClose = null
  for (const id of ['plugin-grid', 'organization-options', 'key-options', 'user-options', 'activity-list']) $(id).replaceChildren()
  $('admin-token').value = ''
  $('tokensapi-token').value = ''
  $('workspace').hidden = true
  $('session-actions').hidden = true
  $('login-panel').hidden = false
}
async function restore() {
  try {
    await load()
    document.body.classList.remove('signed-out')
    $('workspace').hidden = false
    $('session-actions').hidden = false
    $('login-panel').hidden = true
    navigate(location.hash.slice(1))
  } catch (error) {
    lock()
    throw error
  } finally {
    document.body.classList.remove('session-pending')
    $('session-loading').hidden = true
  }
}

$('refresh').onclick = () => action(load, { success: '已刷新。' })
$('plugin-search').oninput = () => session && renderPlugins()
$('visibility-filter').onchange = () => session && renderPlugins()
for (const el of document.querySelectorAll('[data-category]'))
  el.onclick = () => {
    if (busy) return
    stage = el.dataset.category
    document.querySelectorAll('[data-category]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)))
    if (session) renderPlugins()
  }
$('reset-filters').onclick = () => {
  stage = 'all'
  $('plugin-search').value = ''
  $('visibility-filter').value = 'all'
  document.querySelectorAll('[data-category]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.category === 'all')))
  renderPlugins()
}
window.addEventListener('hashchange', () => session && navigate(location.hash.slice(1)))
$('logout').onclick = () => action(async () => {
  await json('/api/v1/session', undefined, 'DELETE')
  lock()
}, { success: '已安全退出登录。' })
$('login-form').onsubmit = (event) => {
  event.preventDefault()
  const credential = $('admin-token').value.trim()
  action(async () => {
    $('admin-token').value = ''
    await json('/api/v1/session', { credential })
    await restore()
  })
}
// An organization administrator signs in with their TokensAPI account: the access token from
// their TokensAPI settings plus the account id TokensAPI requires beside it. The market asks
// TokensAPI who that is and never stores the token.
$('tenant-login-form').onsubmit = (event) => {
  event.preventDefault()
  const userId = Number($('tokensapi-user').value.trim())
  const accessToken = $('tokensapi-token').value.trim()
  action(async () => {
    $('tokensapi-token').value = ''
    await json('/api/v1/session', { tokensapi: true, userId, accessToken })
    await restore()
  })
}
$('login-switch').onclick = () => {
  if (busy) return
  const toPlatform = $('login-form').hidden
  $('login-form').hidden = !toPlatform
  $('tenant-login-form').hidden = toPlatform
  $('login-switch').textContent = toPlatform ? '改用 TokensAPI 账号登录' : '改用后台口令登录'
  feedback()
  $(toPlatform ? 'admin-token' : 'tokensapi-user').focus()
}
const editor = catalogEditor({ request: json, action, reload, close: closeDialog, isBusy: () => busy })
action(restore, { silent401: true })
