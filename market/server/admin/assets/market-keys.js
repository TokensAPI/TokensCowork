/**
 * The Key page: the directory of `sk-` Keys the platform grants plugins to one by one, from here
 * or from a plugin's access dialog. A Key grant stands on its own: organizations, their switches
 * and user grants never add to or take away from it.
 */
export function keysView({ $, node, button, json, action, reload, pluginName, grants }) {
  let items = [],
    displayReady = false,
    editing = null
  // Keys are named by their note, else by their own value; the internal id is never shown.
  const label = (id) => {
    const key = items.find((item) => item.fingerprint === id)
    if (!key) return 'Key（已删除）'
    return key.label || key.apiKey || '未命名 Key'
  }

  function render() {
    $('key-list').replaceChildren(...items.map((key) => {
      const row = document.createElement('tr'),
        actions = node('div', '', 'row-actions'),
        cell = document.createElement('td')
      if (key.apiKey)
        actions.append(button('复制', () => action(async () => {
          await navigator.clipboard.writeText(key.apiKey)
        }, { success: 'Key 已复制到剪贴板。' })))
      actions.append(
        button('授权插件', () => grants.open(`/api/v1/keys/${key.fingerprint}`, label(key.fingerprint))),
        button('改备注', () => edit(key), 'quiet'),
        button('删除', () => {
          const held = key.plugins.length ? `，并移除它的 ${key.plugins.length} 项插件授权` : ''
          if (!confirm(`删除 ${label(key.fingerprint)}${held}？`)) return
          action(async () => {
            await json(`/api/v1/keys/${key.fingerprint}`, undefined, 'DELETE')
            await reload('Key 已删除。')
          })
        }, 'quiet danger'),
      )
      cell.append(actions)
      const value = key.apiKey
        ? node('td', key.apiKey, 'key-value')
        : node('td', '原文未保存，需删除后重新登记', 'muted')
      const plugins = node('td', key.plugins.length ? key.plugins.map(pluginName).join('、') : '—')
      plugins.style.whiteSpace = 'normal'
      row.append(node('td', key.label || '未命名', key.label ? '' : 'muted'), value, plugins, cell)
      return row
    }))
    $('key-empty').hidden = items.length > 0
    $('nav-keys').textContent = items.length
    $('keys-note').textContent = displayReady
      ? `共 ${items.length} 个 Key。单独授权只对这个 Key 生效，与组织、用户授权互不影响。`
      : `共 ${items.length} 个 Key。未配置加密密钥，Key 原文不保存。`
  }

  function edit(key = null) {
    editing = key
    $('key-form').reset()
    $('key-error').textContent = ''
    $('key-dialog-title').textContent = key ? '修改备注' : '登记 Key'
    $('key-value-label').hidden = $('key-value').hidden = !!key
    $('key-value').required = !key
    $('key-label').value = key?.label ?? ''
    $('key-dialog-note').textContent = key ? (key.apiKey || '') : displayReady ? 'Key 原文加密保存' : '未配置加密密钥，原文不会保存'
    $('key-dialog').showModal()
  }
  $('key-form').onsubmit = (event) => {
    event.preventDefault()
    const text = $('key-label').value.trim()
    const value = $('key-value').value.trim()
    action(async () => {
      if (editing) await json(`/api/v1/keys/${editing.fingerprint}`, { label: text }, 'PATCH')
      else await json('/api/v1/keys', { key: value, label: text }, 'POST')
      $('key-value').value = ''
      $('key-dialog').close()
      await reload(editing ? '备注已保存。' : 'Key 已登记，可点「授权插件」或在插件的「访问范围」里勾选。')
    }, { errorTarget: 'key-error' })
  }
  $('cancel-key').onclick = () => {
    $('key-value').value = ''
    $('key-dialog').close()
  }
  $('new-key').onclick = () => edit()

  return {
    all: () => items,
    label,
    set(list) {
      items = list.items
      displayReady = list.displayReady
      render()
    },
    clear() {
      items = []
      editing = null
      $('key-dialog').close()
      $('key-list').replaceChildren()
    },
  }
}
