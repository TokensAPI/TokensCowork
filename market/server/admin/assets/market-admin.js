import { consoleKit, lockControls } from './market-ui.js'
import { catalogEditor } from './market-catalog-editor.js'
import { pluginsView, STATE_NAMES } from './market-plugins.js'
import { organizationsView } from './market-organizations.js'
import { keysView } from './market-keys.js'
import { usersView } from './market-users.js'
import { sessionLogsView } from './market-session-logs.js'
import { docsAdminView } from './market-docs-admin.js'
import { grantsDialog } from './market-grants.js'
import { iconDialog } from './market-plugin-icon.js'
import { marketRequest } from './market-api.js'

// The console shell: sign-in, navigation, feedback, the shared request/action helpers and the
// activity log. Each page lives in its own module and gets these helpers; `plugins` is only the
// name index (every market plugin's id, name, state and scope) that name lookups, grant pickers and
// the docs page need — the plugin page itself is paged on the server (market-plugins.js).
const $ = (id) => document.getElementById(id)
const formatTime = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const views = {
  plugins: ['插件', '管理插件资料、上架状态和访问范围。'],
  organizations: ['组织', '同步 TokensAPI 组织，查看每个组织能用的插件。'],
  keys: ['Key', '登记单独授权用的 Key，给它单独授权插件。'],
  users: ['用户', '给 TokensAPI 用户单独授权插件，对该用户名下所有 Key 生效。'],
  docs: ['插件文档', '上传插件的 Markdown 使用文档和插件图标；用户在文档中心只看到自己有权限的插件。'],
  'session-logs': ['会话日志', '客户端上传的会话日志。点一行查看对话，可下载原始 JSON、加备注和标签。'],
  activity: ['操作记录', '最近的插件、访问范围和组织变更。'],
}
let session = null,
  plugins = [],
  audit = [],
  busy = false,
  currentView = 'plugins'
const platform = () => session?.role === 'platform'
const allowedViews = () => (platform() ? Object.keys(views) : ['organizations'])
const pluginName = (id) => plugins.find((p) => p.id === id)?.displayName || id
const kit = consoleKit({ isBusy: () => busy })
const { node } = kit

let feedbackTimer
function feedback(message = '', kind = 'success') {
  clearTimeout(feedbackTimer)
  const toast = $('message')
  toast.hidePopover?.()
  toast.replaceChildren()
  toast.hidden = !message
  if (!message) return
  toast.className = `alert alert-important alert-dismissible ${kind === 'error' ? 'alert-danger' : 'alert-success'}`
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  const close = node('button', '', 'btn-close')
  close.type = 'button'
  close.setAttribute('aria-label', '关闭提示')
  close.onclick = () => feedback()
  toast.append(node('div', message), close)
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
// Runs one console operation and reports its outcome. By default the whole page is locked until it
// finishes, as every page has always done. With `lock` only those elements are (see lockControls;
// [] locks nothing), and other operations stay possible meanwhile: the session-log page uses it so
// reading never freezes the page and a save holds only its own button or dialog.
async function action(fn, { errorTarget, success, silent401 = false, lock } = {}) {
  if (lock !== undefined) return lockedAction(fn, { errorTarget, success, silent401, lock })
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
      if (errorTarget && session) $(errorTarget).textContent = error.message
    }
  } finally {
    controls.forEach((disabled, el) => {
      el.disabled = disabled
    })
    busy = false
    document.body.removeAttribute('aria-busy')
  }
}
async function lockedAction(fn, { errorTarget, success, silent401, lock }) {
  const release = lockControls(lock)
  if (!release) return
  if (errorTarget) $(errorTarget).textContent = ''
  feedback()
  try {
    await fn()
    if (success) feedback(success)
  } catch (error) {
    if (!(silent401 && error.status === 401)) {
      feedback(error.message + (error.retryAfter ? `（约 ${error.retryAfter} 秒后可重试）` : ''), 'error')
      if (errorTarget && session) $(errorTarget).textContent = error.message
    }
  } finally {
    release()
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
const shared = { $, ...kit, json, action, reload, feedback, formatTime, pluginName, grants, isBusy: () => busy }
const organizations = organizationsView(shared)
const keys = keysView(shared)
const users = usersView(shared)
const sessionLogs = sessionLogsView({ ...shared, organizations })
const icons = iconDialog({ $, json, action, isBusy: () => busy, confirmAction: kit.confirmAction })
const docs = docsAdminView({ ...shared, plugins: () => plugins, icons })
const pluginPage = pluginsView({ ...shared, isSignedIn: () => !!session, organizations, keys, users, editor: () => editor, icons })

// `view` is the hash without '#'. A page may carry a route after a slash (the session-log detail,
// `session-logs/<session>/<format version>`); the page itself reads it from location.hash.
function navigate(view) {
  const open = allowedViews()
  const page = String(view ?? '').split('/')[0]
  currentView = open.includes(page) ? page : open[0]
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== currentView
  // An organization administrator sees its own organization only: no directory actions.
  for (const group of document.querySelectorAll('[data-actions]')) group.hidden = group.dataset.actions !== currentView || !platform()
  for (const link of document.querySelectorAll('[data-view]')) {
    link.hidden = !open.includes(link.dataset.view)
    link.classList.toggle('active', link.dataset.view === currentView)
    if (link.dataset.view === currentView) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  const [title, description] = platform() || currentView !== 'organizations'
    ? views[currentView]
    : ['我的组织', '平台提供给本组织的插件；受限插件可以对本组织关闭，或指定只给哪些成员。']
  $('page-title').textContent = title
  $('page-description').textContent = description
  // On a narrow screen the sidebar is a collapsed menu; picking a page closes it.
  const menu = $('sidebar-menu')
  if (menu.classList.contains('show')) window.tabler?.Collapse?.getOrCreateInstance(menu).hide()
  if (currentView === 'session-logs') sessionLogs.show().catch((error) => feedback(error.message, 'error'))
  if (currentView === 'docs') docs.show().catch((error) => feedback(error.message, 'error'))
}

// Closing a dialog with unsaved edits asks first.
let pendingClose = null
function closeDialog(id) {
  if (busy) return false
  if (id === 'catalog-dialog' ? editor.dirty() : id === 'plugin-dialog' && pluginPage.accessDirty()) {
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
  if (pluginPage.accessDirty() || editor.dirty()) {
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
  'session-log.viewed': '查看会话日志',
  'session-log.downloaded': '下载会话日志',
  'session-log.deleted': '删除会话日志',
  'session-log.settings': '设置日志保留期',
  'session-log.purged': '清理过期会话日志',
  'session-log.annotated': '修改会话备注',
  'plugin.icon.updated': '更新插件图标',
  'plugin.icon.deleted': '移除插件图标',
  'plugin.doc.saved': '保存插件文档',
  'plugin.doc.deleted': '删除插件文档',
  'plugin.doc.image.uploaded': '上传文档图片',
  'plugin.doc.image.deleted': '删除文档图片',
}
function actorText(actor) {
  if (actor?.kind === 'tenant') return `组织管理员 · 用户 ${actor.id}${actor.organizationId ? ` · 组织 #${actor.organizationId}` : ''}`
  if (actor?.kind === 'root' && actor.id?.startsWith('tokensapi:'))
    return `平台口令 · TokensAPI 代用户 ${actor.id.slice('tokensapi:'.length)}${actor.organizationId ? ` · 组织 #${actor.organizationId}` : ''}`
  if (actor?.kind === 'root' && actor.id === 'retention') return '保留期 · 自动清理'
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
  if (event.action.startsWith('plugin.doc.')) return `${pluginName(event.target.split(':')[0])} · 文档 #${event.target.split(':')[1]}`
  if (event.action.startsWith('key.')) return keys.label(event.target)
  if (event.action.startsWith('user.')) return users.label(event.target)
  if (event.action === 'organization.updated') return organizations.label(Number(event.target))
  if (event.action === 'organizations.synced') return ''
  if (event.action.startsWith('session-log.'))
    return event.target === 'range' ? '按日期' : event.target === 'retention' ? '' : event.target.replace(/:(\d+)$/u, '（格式 v$1）')
  return pluginName(event.target)
}
function renderActivity() {
  $('activity-list').replaceChildren(...audit.map((event) => {
    const d = event.details || {},
      facts = []
    if (d.state) facts.push({ ...STATE_NAMES, purged: '已彻底删除' }[d.state] || d.state)
    if (d.visibility) facts.push(d.visibility === 'public' ? '公开' : '受限')
    if (d.organizationCount != null) facts.push(`${d.organizationCount} 个组织`)
    if (d.keyCount != null) facts.push(`${d.keyCount} 个 Key`)
    if (d.userCount != null) facts.push(`${d.userCount} 个用户`)
    if (d.pluginCount != null) facts.push(`共 ${d.pluginCount} 个插件（新增 ${d.added}，撤销 ${d.removed}）`)
    if (d.count != null) facts.push(`${d.count} 个${event.action.startsWith('session-log.') ? '会话' : '组织'}`)
    if ('retentionDays' in d) facts.push(d.retentionDays ? `保留 ${d.retentionDays} 天` : '永久保留')
    if (event.action === 'session-log.downloaded') facts.push(d.format === 'jsonl' ? '下载 JSONL' : '下载 JSON')
    if (event.action === 'session-log.deleted' && Number.isSafeInteger(d.to))
      facts.push(`创建于 ${formatTime(d.from ?? 0)} 至 ${formatTime(d.to)}`)
    if (event.action === 'session-log.annotated')
      facts.push(d.tags?.length ? `标签：${d.tags.join('、')}` : '无标签', d.note ? '有备注' : '无备注')
    if (event.action === 'plugin.icon.updated' && d.bytes != null) facts.push(`${Math.max(1, Math.round(d.bytes / 1024))} KB`)
    if (event.action === 'plugin.doc.saved') facts.push(d.created ? '新增' : '替换')
    if (event.action === 'plugin.doc.image.uploaded' && d.bytes != null) facts.push(`${Math.max(1, Math.round(d.bytes / 1024))} KB`)
    if (d.grantCount != null) facts.push(`移除 ${d.grantCount} 项授权`)
    if (typeof d.enabled === 'boolean') facts.push(d.enabled ? '开启' : '关闭')
    if (d.memberCount != null) facts.push(d.memberCount ? `指定 ${d.memberCount} 位成员可见` : '全员可见')
    const what = node('td')
    const target = targetText(event)
    what.append(node('div', ACTIONS[event.action] || '管理变更', 'fw-medium'))
    if (target) what.append(node('div', target, 'text-secondary small text-break'))
    const row = document.createElement('tr')
    row.append(what, node('td', facts.join(' · ') || (event.action === 'session-log.viewed' ? '打开了会话详情' : '已保存'), 'text-break'),
      node('td', actorText(event.actor), 'text-secondary'), node('td', formatTime(event.createdAt), 'text-secondary text-nowrap'))
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
  $('environment-badge').title = platform() ? env.origin || '尚未配置 TokensAPI 地址' : label
  $('nav-org-label').textContent = platform() ? '组织' : '我的组织'
  // An organization administrator has exactly one organization; a count means nothing there.
  $('nav-orgs').hidden = !platform()
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
    const [index, orgList, keyList, userList, log] = await Promise.all([
      json('/api/v1/plugins?view=index'), json('/api/v1/organizations'), json('/api/v1/keys'), json('/api/v1/users'), json('/api/v1/audit'),
    ])
    plugins = index.items
    audit = log.items
    organizations.set(orgList)
    keys.set(keyList)
    users.set(userList)
    const privateRegistry = $('catalog-registry').querySelector('option[value="tokenscowork"]')
    if (privateRegistry) privateRegistry.disabled = privateRegistry.hidden = !session.environment.privateRegistryReady
    // The plugin rows read organization names, so the page draws after the directories are in.
    await pluginPage.load()
    renderActivity()
    await organizations.refreshDetail()
  }
  $('last-refresh').textContent = `更新于 ${formatTime(Date.now())}`
}
function showSignedIn(signedIn) {
  $('workspace').hidden = !signedIn
  $('sidebar').hidden = !signedIn
  $('session-actions').hidden = !signedIn
  $('login-panel').hidden = signedIn
}
function lock() {
  editor.clear()
  pluginPage.clear()
  organizations.clear()
  keys.clear()
  users.clear()
  sessionLogs.clear()
  docs.clear()
  grants.clear()
  icons.clear()
  session = null
  plugins = []
  audit = []
  for (const id of ['confirm-dialog', 'discard-dialog']) $(id).close()
  pendingClose = null
  $('activity-list').replaceChildren()
  $('admin-token').value = ''
  $('tokensapi-token').value = ''
  showSignedIn(false)
}
async function restore() {
  try {
    await load()
    showSignedIn(true)
    navigate(location.hash.slice(1))
  } catch (error) {
    lock()
    throw error
  } finally {
    document.body.classList.remove('session-pending')
    $('session-loading').hidden = true
  }
}

$('refresh').onclick = () => action(async () => {
  await load()
  if (currentView === 'session-logs') await sessionLogs.show()
  if (currentView === 'docs') await docs.show()
}, { success: '已刷新。' })
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
