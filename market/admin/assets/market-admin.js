import { marketRequest } from './market-api.js'
import {
  mergePlugins,
  keyGrants,
  filterPlugins,
  parseKeys,
  effectiveNewKeys,
} from './market-model.js'

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
const views = {
  plugins: ['插件与权限', '统一管理可选插件的访问范围。'],
  organizations: ['组织名录', '同步组织信息，按团队分配插件访问权限。'],
  verify: ['授权验证', '输入一个 Key，确认它实际能够访问哪些插件。'],
  activity: ['操作记录', '查看最近的权限变更和组织维护记录。'],
}
let state,
  operations,
  plugins = [],
  busy = false,
  category = 'all'
let selectedPlugin,
  retained = new Set(),
  selectedOrgs = new Set(),
  keyValues = new Map()
let pluginBaseline = '',
  orgBaseline = '',
  currentView = 'plugins'
const builtin = (p) => p.category === 'builtin'
const saved = (id) => state?.plugins.find((p) => p.id === id)
const restricted = (p) =>
  !builtin(p) && saved(p.id)?.visibility === 'restricted'
const orgIds = (id) =>
  state.organizationGrants
    .filter((g) => g.plugin_id === id)
    .map((g) => g.organization_id)
const orgCount = (id) =>
  new Set(
    state.organizationGrants
      .filter(
        (g) =>
          g.organization_id === id &&
          plugins.some((p) => p.id === g.plugin_id && restricted(p)),
      )
      .map((g) => g.plugin_id),
  ).size
const orgName = (id) => {
  const org = state.organizations.find((o) => o.id === id)
  return org
    ? `${org.name} (#${id})${org.enabled ? '' : ' · 已停用'}`
    : `#${id} · 未登记`
}
const formatTime = (value) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false })
function feedback(message = '', kind = 'success') {
  $('message').textContent = message
  $('message').dataset.kind = kind
}
async function json(path, data) {
  try {
    return await marketRequest(path, data)
  } catch (error) {
    if (error.status === 401 && path !== '/api/admin/login') {
      lock()
      error.message = '登录已过期，请重新登录。'
    }
    throw error
  }
}
async function action(fn, { errorTarget, success, silent401 = false } = {}) {
  if (busy) return
  busy = true
  const controls = new Map(
    [...document.querySelectorAll('button,input,textarea,select')].map((el) => [
      el,
      el.disabled,
    ]),
  )
  controls.forEach((_, el) => {
    el.disabled = true
  })
  document.body.setAttribute('aria-busy', 'true')
  if (errorTarget) $(errorTarget).textContent = ''
  feedback()
  try {
    await fn()
    if (success) feedback(typeof success === 'function' ? success() : success)
  } catch (error) {
    if (!(silent401 && error.status === 401)) {
      feedback(
        error.message +
          (error.retryAfter ? `（约 ${error.retryAfter} 秒后可重试）` : ''),
        'error',
      )
      if (errorTarget && !document.body.classList.contains('signed-out'))
        $(errorTarget).textContent = error.message
    }
  } finally {
    controls.forEach((disabled, el) => {
      el.disabled = disabled
    })
    busy = false
    document.body.removeAttribute('aria-busy')
    $('sync-organizations').disabled = !state?.organizationListReady
  }
}
function navigate(view) {
  currentView = Object.hasOwn(views, view) ? view : 'plugins'
  for (const panel of document.querySelectorAll('[data-panel]'))
    panel.hidden = panel.dataset.panel !== currentView
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === currentView)
      link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  $('page-title').textContent = views[currentView][0]
  $('page-description').textContent = views[currentView][1]
}
function renderPlugins() {
  const visible = filterPlugins(plugins, state, {
    category,
    query: $('plugin-search').value,
    visibility: $('visibility-filter').value,
  })
  const cards = visible.map((p) => {
    const card = node('article', '', 'plugin-card'),
      top = node('div', '', 'card-top'),
      name = node('div', '', 'card-name')
    name.append(node('h2', p.displayName), node('div', p.package, 'package'))
    top.append(
      node('div', p.displayName.slice(0, 1), 'plugin-icon'),
      name,
      node(
        'span',
        builtin(p) ? '内置' : restricted(p) ? '受限' : '公开',
        'badge' +
          (builtin(p) ? ' builtin' : restricted(p) ? ' restricted' : ''),
      ),
    )
    const grants = node('div', '', 'grant-summary')
    if (builtin(p)) grants.append(node('span', '无需安装 · 不支持卸载', 'chip'))
    else if (!restricted(p)) grants.append(node('span', '所有人可见', 'chip'))
    else {
      const ids = orgIds(p.id)
      grants.append(
        node('span', `${ids.length} 个组织`, 'chip'),
        node('span', `${keyGrants(state, p.id).length} 个 Key`, 'chip'),
      )
      grants.title = ids.map(orgName).join('、')
      const disabled = ids.filter(
        (id) => !state.organizations.find((o) => o.id === id)?.enabled,
      ).length
      if (disabled)
        grants.append(node('span', `${disabled} 个组织已停用`, 'chip disabled'))
    }
    const bottom = node('div', '', 'card-bottom')
    bottom.append(
      node(
        'span',
        `v${p.version} · ${builtin(p) ? '随应用更新' : p.npm ? '名册版本 / npm 自动更新' : '名册版本'}`,
        'version',
      ),
    )
    if (builtin(p)) bottom.append(node('span', '应用内置', 'muted'))
    else {
      const edit = button('配置权限', () => action(() => openPlugin(p)))
      edit.setAttribute('aria-label', `${p.displayName} 配置权限`)
      bottom.append(edit)
    }
    card.append(top, node('p', p.summary, 'description'), grants, bottom)
    return card
  })
  $('plugin-grid').replaceChildren(...cards)
  $('empty').hidden = visible.length > 0
  $('plugin-result-count').textContent =
    `显示 ${visible.length} / ${plugins.length} 项`
  $('stat-total').textContent = plugins.length
  $('stat-builtin').textContent = plugins.filter(builtin).length
  $('stat-optional').textContent = plugins.filter((p) => !builtin(p)).length
  $('stat-restricted').textContent = plugins.filter(restricted).length
  $('nav-plugins').textContent = plugins.length
}
function renderOrganizations() {
  const query = $('org-search').value.trim().toLowerCase(),
    status = $('org-status-filter').value
  const visible = state.organizations.filter(
    (o) =>
      `${o.name} ${o.id}`.toLowerCase().includes(query) &&
      (status === 'all' || (status === 'enabled') === !!o.enabled),
  )
  $('organization-list').replaceChildren(
    ...visible.map((org) => {
      const row = node('tr'),
        statusCell = node('td'),
        editCell = node('td')
      statusCell.append(
        node(
          'span',
          org.enabled ? '已启用' : '已停用',
          `badge${org.enabled ? '' : ' restricted'}`,
        ),
      )
      const edit = button('编辑', () => openOrganization(org), 'quiet')
      edit.setAttribute('aria-label', `编辑组织 ${org.name}`)
      editCell.append(edit)
      row.append(
        node('td', org.name),
        node('td', `#${org.id}`, 'muted'),
        node('td', `${orgCount(org.id)} 个`),
        statusCell,
        editCell,
      )
      return row
    }),
  )
  $('org-empty').hidden = visible.length > 0
  $('nav-orgs').textContent = state.organizations.length
}
function renderOperations() {
  const env = operations.environment
  const label =
    env.name === 'production'
      ? '正式环境'
      : env.name === 'development'
        ? '测试环境'
        : '未配置环境'
  $('environment-badge').textContent = label
  $('sidebar-environment').textContent = label
  $('environment-badge').title = env.origin || '尚未配置 TokensAPI 地址'
  const sync = operations.recentActions.find(
    (item) => item.action === 'organizations.synced',
  )
  $('provider-status').textContent =
    `${env.origin || '组织服务未配置'} · ${state.organizationListReady ? '同步接口已配置' : '同步接口未配置'}${sync ? ` · 最近同步 ${formatTime(sync.createdAt)}` : ' · 点击同步可验证连接'}。切换环境前需核对组织 ID 与授权，不能直接复用不同环境的组织关系。`
  const labels = {
    'plugin.access.updated': '更新插件权限',
    'organization.updated': '维护组织',
    'organizations.synced': '同步组织名录',
  }
  $('activity-list').replaceChildren(
    ...operations.recentActions.map((event) => {
      const row = node('div', '', 'activity-row'),
        detail = node('div', '', 'activity-text')
      const d = event.details || {},
        counts = []
      if (d.visibility) counts.push(d.visibility === 'public' ? '公开' : '受限')
      if (d.organizationCount != null)
        counts.push(`${d.organizationCount} 个组织`)
      if (d.keyCount != null) counts.push(`${d.keyCount} 个 Key`)
      if (d.count != null) counts.push(`${d.count} 个组织`)
      if (typeof d.enabled === 'boolean')
        counts.push(d.enabled ? '已启用' : '已停用')
      const plugin = plugins.find((p) => p.id === event.target)
      detail.append(
        node(
          'strong',
          `${labels[event.action] || '管理变更'}${event.target ? ` · ${plugin?.displayName || event.target}` : ''}`,
        ),
        node('p', counts.join(' · ') || '配置已保存', 'muted'),
      )
      row.append(
        node('span', '✓', 'activity-mark'),
        detail,
        node('time', formatTime(event.createdAt), 'muted'),
      )
      return row
    }),
  )
  $('activity-empty').hidden = operations.recentActions.length > 0
}
async function load() {
  const [next, roster, ops] = await Promise.all([
    json('/api/admin/access'),
    json('/api/admin/roster'),
    json('/api/admin/operations'),
  ])
  state = next
  plugins = mergePlugins(roster, next)
  operations = ops
  renderPlugins()
  renderOrganizations()
  renderOperations()
  $('sync-organizations').disabled = !state.organizationListReady
  $('last-refresh').textContent = `更新于 ${formatTime(Date.now())}`
}
async function refreshAfterSave(message) {
  try {
    await load()
    feedback(message)
  } catch (error) {
    feedback(
      `${message} 但页面刷新失败：${error.message} 请刷新核对，无需重复保存。`,
      'error',
    )
  }
}
const newKeys = () =>
  effectiveNewKeys(
    $('api-keys').value,
    [...retained].map((fp) => keyValues.get(fp)),
  )
const pluginDraft = () =>
  JSON.stringify({
    orgs: [...selectedOrgs].sort((a, b) => a - b),
    keys: [...retained].sort(),
    added: parseKeys($('api-keys').value).sort(),
  })
const organizationDraft = () =>
  JSON.stringify({
    id: $('organization-id').value,
    name: $('organization-name').value.trim(),
    enabled: $('organization-enabled').checked,
  })
const pluginDirty = () =>
  $('plugin-dialog').open && pluginDraft() !== pluginBaseline
const orgDirty = () =>
  $('org-dialog').open && organizationDraft() !== orgBaseline
let pendingClose = null
function closeDialog(id) {
  if (busy) return false
  if (id === 'plugin-dialog' ? pluginDirty() : orgDirty()) {
    pendingClose = id
    $('discard-dialog').showModal()
    $('keep-editing').focus()
    return false
  }
  $(id).close()
  return true
}
function updateScope() {
  const count = selectedOrgs.size,
    added = newKeys().length,
    totalKeys = retained.size + added
  $('permission-summary').textContent =
    count || totalKeys
      ? `${count} 个组织 · ${totalKeys} 个 Key`
      : '公开 · 所有人可见'
  $('selected-org-count').textContent = `已选 ${count} 个`
  $('saved-key-count').textContent = `已保留 ${retained.size} 个`
  $('key-input-help').textContent =
    `本次新增 ${added} 个 Key · 自动合并重复项 · 每个插件最多 100 个 Key`
  $('public-confirmation').hidden =
    saved(selectedPlugin?.id)?.visibility !== 'restricted' ||
    !!count ||
    !!totalKeys
  if ($('public-confirmation').hidden) $('confirm-public').checked = false
}
function renderOrgOptions() {
  const query = $('organization-search').value.trim().toLowerCase()
  const visible = state.organizations.filter((org) =>
    `${org.name} ${org.id}`.toLowerCase().includes(query),
  )
  $('organization-options').replaceChildren(
    ...visible.map((org) => {
      const label = node('label'),
        checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = org.id
      checkbox.checked = selectedOrgs.has(org.id)
      checkbox.onchange = () => {
        if (checkbox.checked) selectedOrgs.add(org.id)
        else selectedOrgs.delete(org.id)
        updateScope()
      }
      label.append(checkbox, document.createTextNode(` ${orgName(org.id)}`))
      return label
    }),
  )
  if (!visible.length)
    $('organization-options').append(
      node(
        'p',
        state.organizations.length
          ? '没有匹配的组织，已选项仍保留。'
          : '暂无组织。请先同步组织名录，也可以仅配置单独 Key。',
        'muted',
      ),
    )
}
function renderKeys() {
  $('saved-keys').replaceChildren(
    ...[...retained].map((fp) => {
      const row = node('div', '', 'saved-key-row'),
        value = keyValues.get(fp)
      row.append(
        node(
          'code',
          value || `旧指纹 ${fp.slice(0, 10)}（重新录入原 Key 可补全）`,
        ),
      )
      if (value)
        row.append(
          button(
            '复制',
            () =>
              action(
                async () => {
                  try {
                    await navigator.clipboard.writeText(value)
                  } catch {
                    throw new Error('无法访问剪贴板，请选中 Key 手动复制。')
                  }
                  $('plugin-error').textContent = 'Key 已复制，请妥善保管。'
                },
                { errorTarget: 'plugin-error' },
              ),
            'quiet',
          ),
        )
      const remove = button(
        '移除',
        () => {
          retained.delete(fp)
          renderKeys()
          updateScope()
        },
        'quiet danger',
      )
      remove.setAttribute('aria-label', `移除 Key ${fp.slice(0, 10)}`)
      row.append(remove)
      return row
    }),
  )
  if (!retained.size)
    $('saved-keys').append(node('p', '尚未配置单独 Key。', 'muted'))
}
async function openPlugin(plugin) {
  if (builtin(plugin)) return
  const values = await json(
    `/api/admin/plugin-key-values?id=${encodeURIComponent(plugin.id)}`,
  )
  keyValues = new Map(values.keys.map((k) => [k.fingerprint, k.apiKey]))
  selectedPlugin = plugin
  retained = new Set(keyGrants(state, plugin.id))
  selectedOrgs = new Set(orgIds(plugin.id))
  $('plugin-title').textContent = plugin.displayName
  $('plugin-package').textContent = plugin.package
  $('plugin-error').textContent = ''
  $('confirm-public').checked = false
  $('api-keys').value = ''
  $('organization-search').value = ''
  $('legacy-note').hidden =
    state.organizationPolicies.some((p) => p.plugin_id === plugin.id) ||
    !retained.size
  renderOrgOptions()
  renderKeys()
  updateScope()
  pluginBaseline = pluginDraft()
  $('plugin-dialog').showModal()
}
function updateOrganizationImpact() {
  const count = orgCount(Number($('organization-id').value))
  $('organization-impact').textContent = $('organization-enabled').checked
    ? `已启用。当前关联 ${count} 个受限插件；同步名录不会改变这里的启停选择。`
    : `停用后，此组织的 ${count} 个关联插件将不再通过组织授权放行。单独 Key 授权仍有效，原组织授权关系会保留。`
}
function openOrganization(org) {
  $('organization-form').reset()
  $('org-error').textContent = ''
  $('org-dialog-title').textContent = org ? '编辑组织' : '登记组织'
  $('organization-id').value = org?.id ?? ''
  $('organization-id').readOnly = !!org
  $('organization-name').value = org?.name ?? ''
  $('organization-enabled').checked = org ? !!org.enabled : true
  updateOrganizationImpact()
  orgBaseline = organizationDraft()
  $('org-dialog').showModal()
}
function clearPreview() {
  $('verify-key').value = ''
  $('verify-result').hidden = true
  $('verify-summary').textContent = ''
  $('verify-plugins').replaceChildren()
  $('verify-error').textContent = ''
}
function lock() {
  document.body.classList.add('signed-out')
  state = null
  operations = null
  plugins = []
  selectedPlugin = null
  $('plugin-dialog').close()
  $('org-dialog').close()
  $('discard-dialog').close()
  pendingClose = null
  keyValues.clear()
  retained.clear()
  selectedOrgs.clear()
  for (const id of [
    'saved-keys',
    'plugin-grid',
    'organization-list',
    'organization-options',
    'activity-list',
  ])
    $(id).replaceChildren()
  $('api-keys').value = ''
  $('admin-token').value = ''
  $('organization-form').reset()
  clearPreview()
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

$('refresh').onclick = () => action(load, { success: '已刷新最新配置。' })
$('plugin-search').oninput = () => {
  if (state) renderPlugins()
}
$('visibility-filter').onchange = () => {
  if (state) renderPlugins()
}
for (const el of document.querySelectorAll('[data-category]'))
  el.onclick = () => {
    if (busy) return
    category = el.dataset.category
    document
      .querySelectorAll('[data-category]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === el)))
    if (state) renderPlugins()
  }
$('reset-filters').onclick = () => {
  category = 'all'
  $('plugin-search').value = ''
  $('visibility-filter').value = 'all'
  document
    .querySelectorAll('[data-category]')
    .forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.category === 'all')),
    )
  renderPlugins()
}
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)))
window.addEventListener('beforeunload', (event) => {
  if (pluginDirty() || orgDirty()) {
    event.preventDefault()
    event.returnValue = ''
  }
})
for (const [id, cancel] of [
  ['plugin-dialog', 'cancel-plugin'],
  ['org-dialog', 'cancel-org'],
]) {
  $(cancel).onclick = () => closeDialog(id)
  $(id).addEventListener('cancel', (event) => {
    event.preventDefault()
    closeDialog(id)
  })
}
$('plugin-dialog').addEventListener('close', () => {
  keyValues.clear()
  retained.clear()
  selectedOrgs.clear()
  selectedPlugin = null
  $('saved-keys').replaceChildren()
  $('organization-options').replaceChildren()
  $('api-keys').value = ''
})
$('organization-search').oninput = renderOrgOptions
$('api-keys').oninput = updateScope
$('plugin-access-form').onsubmit = (event) => {
  event.preventDefault()
  if (busy) return
  if (!$('public-confirmation').hidden && !$('confirm-public').checked) {
    $('plugin-error').textContent = '请确认将插件公开，或保留至少一项授权。'
    return
  }
  const added = newKeys()
  if (
    !added.every((k) => /^sk-\S+$/u.test(k) && k.length <= 512) ||
    added.length > 100 ||
    (retained.size + added.length > 100 &&
      [...retained].every((fp) => keyValues.has(fp)))
  ) {
    $('plugin-error').textContent =
      '请每行填写一个 sk- 开头的有效 Key，总数不超过 100 个。'
    return
  }
  const p = selectedPlugin
  const payload = {
    id: p.id,
    metadata: p,
    objectKey: saved(p.id)?.object_key ?? null,
    organizationIds: [...selectedOrgs],
    apiKeys: added,
    keepFingerprints: [...retained],
    confirmPublic: $('confirm-public').checked,
  }
  action(
    async () => {
      await json('/api/admin/plugin-access', payload)
      $('plugin-dialog').close()
      await refreshAfterSave(`${p.displayName} 的访问权限已保存。`)
    },
    { errorTarget: 'plugin-error' },
  )
}
$('org-search').oninput = () => {
  if (state) renderOrganizations()
}
$('org-status-filter').onchange = () => {
  if (state) renderOrganizations()
}
$('new-organization').onclick = () => {
  if (!busy) openOrganization()
}
$('organization-enabled').onchange = updateOrganizationImpact
$('organization-id').oninput = updateOrganizationImpact
$('organization-form').onsubmit = (event) => {
  event.preventDefault()
  const payload = {
    id: Number($('organization-id').value),
    name: $('organization-name').value.trim(),
    enabled: $('organization-enabled').checked,
  }
  if (!Number.isSafeInteger(payload.id) || payload.id <= 0 || !payload.name) {
    $('org-error').textContent = '请填写有效的组织 ID 和名称。'
    return
  }
  if (
    !$('organization-id').readOnly &&
    state.organizations.some((o) => o.id === payload.id)
  ) {
    $('org-error').textContent = '此组织 ID 已存在，请从组织名录中编辑。'
    return
  }
  action(
    async () => {
      await json('/api/admin/organizations', payload)
      $('org-dialog').close()
      await refreshAfterSave('组织配置已保存。')
    },
    { errorTarget: 'org-error' },
  )
}
$('sync-organizations').onclick = () =>
  action(async () => {
    const result = await json('/api/admin/organizations/sync', {})
    await refreshAfterSave(
      `同步成功，已更新 ${result.count} 个组织。原有停用状态与授权关系保持不变。`,
    )
  })
$('verify-key').oninput = () => {
  $('verify-result').hidden = true
  $('verify-summary').textContent = ''
  $('verify-plugins').replaceChildren()
  $('verify-error').textContent = ''
}
$('verify-form').onsubmit = (event) => {
  event.preventDefault()
  const apiKey = $('verify-key').value.trim()
  if (!/^sk-\S+$/u.test(apiKey)) {
    $('verify-error').textContent = '请输入 sk- 开头的 API Key。'
    return
  }
  action(
    async () => {
      clearPreview()
      const result = await json('/api/admin/access-preview', { apiKey })
      const org = result.organization
      const identity = org
        ? `组织：${org.name} (#${org.id})${!org.registered ? ' · 未登记到名录' : !org.enabled ? ' · 本地已停用' : ''}`
        : result.organizationStatus === 'none'
          ? '未识别到可用组织（个人 Key、无效或停用 Key 均可能出现）'
          : '组织识别暂不可用'
      $('verify-summary').textContent =
        `${identity}。可见 ${result.summary.allowed} / ${result.summary.total} 项。${result.warning || ''}`
      const reasons = {
        public: '公开访问',
        direct: '单独 Key 授权',
        organization: '组织授权',
        denied: '未匹配有效授权',
      }
      $('verify-plugins').replaceChildren(
        ...result.items.map((p) => {
          const row = node('tr'),
            name = node('td'),
            status = node('td')
          name.append(
            node('strong', p.displayName),
            node('div', p.package, 'package'),
          )
          status.append(
            node(
              'span',
              p.allowed ? '可见' : '不可见',
              `badge${p.allowed ? '' : ' restricted'}`,
            ),
          )
          row.append(
            name,
            status,
            node('td', reasons[p.reason] || '未匹配有效授权'),
          )
          return row
        }),
      )
      $('verify-result').hidden = false
    },
    { errorTarget: 'verify-error' },
  )
}
$('logout').onclick = () =>
  action(
    async () => {
      await json('/api/admin/logout', {})
      lock()
    },
    { success: '已安全退出登录。' },
  )
$('keep-editing').onclick = () => $('discard-dialog').close()
$('discard-changes').onclick = () => {
  const target = pendingClose
  $('discard-dialog').close()
  if (target) $(target).close()
  pendingClose = null
}
$('login-form').onsubmit = (event) => {
  event.preventDefault()
  const credential = $('admin-token').value.trim()
  action(async () => {
    $('admin-token').value = ''
    await json('/api/admin/login', { credential })
    await restore()
  })
}
action(restore, { silent401: true })
