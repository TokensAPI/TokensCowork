/**
 * The Users page: TokensAPI users the platform grants plugins to one by one. A user grant follows
 * the user to every Key they own. TokensAPI keeps the accounts; the market only records the user
 * number and the name shown here.
 */
export function usersView({ $, node, button, rowActions, confirmAction, json, action, reload, pluginName, grants }) {
  let items = [],
    searchReady = false,
    editing = null
  const byId = (id) => items.find((user) => user.id === id)
  const label = (id) => {
    const user = byId(Number(id))
    return user ? `${user.name} (#${id})` : `用户 #${id}`
  }

  function render() {
    const query = $('user-directory-search').value.trim().toLowerCase()
    const visible = items.filter((user) => `${user.name} ${user.id}`.toLowerCase().includes(query))
    $('user-list').replaceChildren(...visible.map((user) => {
      const row = document.createElement('tr'),
        cell = document.createElement('td')
      cell.append(rowActions(label(user.id), { label: '授权插件', run: () => grants.open(`/api/v1/users/${user.id}`, label(user.id)) }, [
        { label: '改名', run: () => edit(user) },
        'divider',
        { label: '移除', danger: true, run: async () => {
          const held = user.plugins.length ? `它的 ${user.plugins.length} 项插件授权一并撤掉，对该用户名下所有 Key 生效。` : '它目前没有单独授权的插件。'
          if (!(await confirmAction({ title: `移除用户 ${label(user.id)}？`, ok: '移除用户',
            text: `${held}TokensAPI 里的账号、组织授权和单独登记的 Key 不受影响。` }))) return
          action(async () => {
            await json(`/api/v1/users/${user.id}`, undefined, 'DELETE')
            await reload('用户已移除。')
          })
        } },
      ]))
      const plugins = node('td', user.plugins.length ? user.plugins.map(pluginName).join('、') : '—', 'text-break')
      row.append(node('td', user.name, 'fw-medium text-break'), node('td', String(user.id), 'font-monospace'), plugins, cell)
      return row
    }))
    $('user-empty').hidden = items.length > 0
    $('nav-users').textContent = items.length
    $('users-note').textContent = searchReady
      ? `共 ${items.length} 个用户。添加时可从 TokensAPI 搜索。`
      : `共 ${items.length} 个用户。未配置 TokensAPI 用户搜索，添加时需手动填写用户 ID。`
  }

  function edit(user = null) {
    editing = user
    $('user-form').reset()
    $('user-error').textContent = ''
    $('user-dialog-title').textContent = user ? '修改名称' : '添加用户'
    $('user-lookup-row').hidden = !!user || !searchReady
    $('user-lookup-results').replaceChildren()
    $('user-id').value = user?.id ?? ''
    $('user-id').readOnly = !!user
    $('user-name').value = user?.name ?? ''
    $('user-dialog').showModal()
  }
  $('user-lookup-button').onclick = () => {
    const keyword = $('user-lookup').value.trim()
    if (!keyword) return
    action(async () => {
      const found = await json(`/api/v1/users/search?keyword=${encodeURIComponent(keyword)}`)
      $('user-lookup-results').replaceChildren(...found.items.map((user) => {
        const pick = button(`${user.name}${user.username && user.username !== user.name ? ' · ' + user.username : ''} (#${user.id})`, () => {
          $('user-id').value = user.id
          $('user-name').value = user.name
        }, 'btn btn-sm')
        return pick
      }))
      if (!found.items.length) $('user-lookup-results').append(node('p', '没有找到匹配的用户。', 'text-secondary m-0'))
    }, { errorTarget: 'user-error' })
  }
  $('user-form').onsubmit = (event) => {
    event.preventDefault()
    const id = Number($('user-id').value)
    const name = $('user-name').value.trim()
    const adding = !editing
    action(async () => {
      await json(`/api/v1/users/${id}`, { name })
      $('user-dialog').close()
      await reload(adding ? `${name} 已添加。` : '名称已保存。')
    }, { errorTarget: 'user-error' }).then(() => {
      // A new user is added to be granted something; go straight there.
      if (adding && byId(id) && !$('user-dialog').open) grants.open(`/api/v1/users/${id}`, label(id))
    })
  }
  $('cancel-user').onclick = () => $('user-dialog').close()
  $('new-user').onclick = () => edit()
  $('user-directory-search').oninput = render

  return {
    all: () => items,
    label,
    set(list) {
      items = list.items
      searchReady = list.searchReady
      render()
    },
    clear() {
      items = []
      editing = null
      $('user-dialog').close()
      $('user-list').replaceChildren()
      $('user-lookup-results').replaceChildren()
    },
  }
}
