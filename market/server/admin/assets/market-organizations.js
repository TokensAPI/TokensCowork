/**
 * The Organizations page. The platform administrator keeps the directory (sync, register, enable)
 * and opens one organization to see what its members are offered. An organization administrator
 * lands straight on its own organization and can only switch its granted plugins off or on.
 */
export function organizationsView({ $, node, button, json, action, reload, grants }) {
  let items = [],
    syncReady = false,
    detail = null,
    locked = false,
    editing = null
  const byId = (id) => items.find((org) => org.id === id)
  const label = (id) => {
    const org = byId(id)
    return org ? `${org.name} (#${id})` : `组织 #${id}`
  }

  function renderDirectory() {
    const query = $('org-search').value.trim().toLowerCase()
    const visible = items.filter((org) => `${org.name} ${org.id}`.toLowerCase().includes(query))
    $('organization-list').replaceChildren(...visible.map((org) => {
      const row = document.createElement('tr')
      const name = document.createElement('td')
      name.append(node('strong', org.name))
      if (org.hidden) name.append(node('div', `组织管理员关闭了 ${org.hidden} 个插件`, 'muted'))
      const actions = node('div', '', 'row-actions')
      actions.append(
        button('查看插件', () => action(() => open(org.id))),
        button('授权插件', () => grants.open(`/api/v1/organizations/${org.id}`, label(org.id))),
        button('编辑', () => edit(org), 'quiet'),
        button(org.enabled ? '停用' : '启用', () => action(async () => {
          await json(`/api/v1/organizations/${org.id}`, { name: org.name, enabled: !org.enabled })
          await reload(`${org.name} 已${org.enabled ? '停用' : '启用'}。`)
        }), org.enabled ? 'quiet danger' : 'secondary'),
      )
      const cell = document.createElement('td')
      cell.append(actions)
      row.append(name, node('td', String(org.id), 'fingerprint'), node('td', org.granted ? `${org.granted} 个插件` : '—'),
        node('td', org.enabled ? '启用' : '已停用', org.enabled ? '' : 'muted'), cell)
      return row
    }))
    $('org-empty').hidden = items.length > 0
    $('nav-orgs').textContent = items.length
    $('sync-organizations').hidden = !syncReady
    $('org-directory-note').textContent = syncReady
      ? `共 ${items.length} 个组织。同步会从 TokensAPI 补齐新组织、更新名称，不会删除或停用已有组织。`
      : `共 ${items.length} 个组织。未配置 TokensAPI 组织名录，只能手动登记。`
  }

  const SOURCES = { public: '公开', organization: '组织授权' }
  function renderDetail() {
    $('org-directory').hidden = locked || !!detail
    $('org-detail').hidden = !detail
    $('org-back').hidden = locked
    if (!detail) return
    $('org-detail-title').textContent = `${detail.organization.name} (#${detail.organization.id})` +
      (detail.organization.enabled ? '' : ' · 已停用')
    $('org-plugin-list').replaceChildren(...detail.items.map((plugin) => {
      const row = document.createElement('tr'),
        name = document.createElement('td')
      name.append(node('strong', plugin.displayName), node('div', plugin.package, 'package'))
      const cell = document.createElement('td')
      if (plugin.switchable) {
        cell.append(button(plugin.enabled ? '对本组织关闭' : '对本组织开启', () => action(async () => {
          await json(`/api/v1/organizations/${detail.organization.id}/plugins/${encodeURIComponent(plugin.id)}`, { enabled: !plugin.enabled })
          await reload(`${plugin.displayName} 已对本组织${plugin.enabled ? '关闭' : '开启'}。`)
        }), plugin.enabled ? 'quiet danger' : 'secondary'))
      } else cell.append(node('span', '所有人可见', 'muted'))
      row.append(name, node('td', SOURCES[plugin.source] || plugin.source),
        node('td', plugin.visible ? '可见' : plugin.enabled ? '不可见（组织已停用）' : '已关闭', plugin.visible ? '' : 'muted'), cell)
      return row
    }))
    $('org-plugin-empty').hidden = detail.items.length > 0
  }

  async function open(id) {
    const [organization, plugins] = await Promise.all([
      json(`/api/v1/organizations/${id}`), json(`/api/v1/organizations/${id}/plugins`),
    ])
    detail = { organization, items: plugins.items }
    renderDetail()
  }

  function edit(org = null) {
    editing = org
    $('organization-form').reset()
    $('org-error').textContent = ''
    $('org-dialog-title').textContent = org ? '编辑组织' : '登记组织'
    $('organization-id').value = org?.id ?? ''
    $('organization-id').readOnly = !!org
    $('organization-name').value = org?.name ?? ''
    $('organization-enabled').checked = org?.enabled ?? true
    $('org-dialog').showModal()
  }
  $('organization-form').onsubmit = (event) => {
    event.preventDefault()
    const id = Number($('organization-id').value)
    const name = $('organization-name').value.trim()
    action(async () => {
      await json(`/api/v1/organizations/${id}`, { name, enabled: $('organization-enabled').checked })
      $('org-dialog').close()
      await reload(editing ? '组织已保存。' : `${name} 已登记。`)
    }, { errorTarget: 'org-error' })
  }
  $('cancel-org').onclick = () => $('org-dialog').close()
  $('new-organization').onclick = () => edit()
  $('sync-organizations').onclick = () => action(async () => {
    const { count } = await json('/api/v1/organizations/sync', {}, 'POST')
    await reload(`已同步 ${count} 个组织。`)
  })
  $('org-back').onclick = () => {
    detail = null
    renderDetail()
  }
  $('org-search').oninput = renderDirectory

  return {
    all: () => items,
    byId,
    label,
    set(list) {
      locked = false
      items = list.items
      syncReady = list.syncReady
      renderDirectory()
    },
    // The organization administrator's whole console: its own organization, no directory.
    async lockTo(id) {
      locked = true
      await open(id)
      items = [detail.organization]
    },
    async refreshDetail() {
      if (detail) await open(detail.organization.id)
      else renderDetail()
    },
    clear() {
      items = []
      detail = null
      locked = false
      editing = null
      $('org-dialog').close()
      $('organization-list').replaceChildren()
      $('org-plugin-list').replaceChildren()
      $('org-directory').hidden = false
      $('org-detail').hidden = true
    },
  }
}
