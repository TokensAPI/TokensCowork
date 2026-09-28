/**
 * The Users page: TokensAPI users the platform grants plugins to one by one. A user grant follows
 * the user to every Key they own. TokensAPI keeps the accounts; the market only records the user
 * number and the name shown here.
 */
export function usersView({ $, node, button, json, action, reload, pluginName, grants }) {
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
        actions = node('div', '', 'row-actions'),
        cell = document.createElement('td')
      actions.append(
        button('授权插件', () => grants.open(`/api/v1/users/${user.id}`, label(user.id))),
        button('改名', () => edit(user), 'quiet'),
        button('移除', () => {
          const held = user.plugins.length ? `，并撤掉它的 ${user.plugins.length} 项插件授权` : ''
          if (!confirm(`移除 ${label(user.id)}${held}？`)) return
          action(async () => {
            await json(`/api/v1/users/${user.id}`, undefined, 'DELETE')
            await reload('用户已移除。')
          })
        }, 'quiet danger'),
      )
      cell.append(actions)
      const plugins = node('td', user.plugins.length ? user.plugins.map(pluginName).join('、') : '—')
      plugins.style.whiteSpace = 'normal'
      row.append(node('td', user.name), node('td', String(user.id), 'fingerprint'), plugins, cell)
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
        }, 'quiet')
        return pick
      }))
      if (!found.items.length) $('user-lookup-results').append(node('p', '没有找到匹配的用户。', 'muted'))
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
