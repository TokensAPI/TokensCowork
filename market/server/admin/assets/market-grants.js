/**
 * The per-subject grant dialog: every plugin one organization, Key or user holds, ticked on one
 * list and saved as a whole. The plugin dialog edits the same grants from the plugin's side.
 */
export function grantsDialog({ $, node, json, action, reload, plugins }) {
  let path = '',
    who = '',
    chosen = new Set()
  // Built-in components are the application's, a trashed plugin cannot be granted, and a public
  // plugin is open to everyone already. Grants kept on a public plugin stay untouched on save and
  // apply again once it is restricted.
  const grantable = () => plugins().filter((p) => p.category !== 'builtin' && p.state !== 'deleted' && p.visibility !== 'public')

  function render() {
    const search = $('grant-search').value.trim().toLowerCase()
    const items = grantable()
    const visible = items.filter((p) => `${p.displayName} ${p.package} ${p.id}`.toLowerCase().includes(search))
    $('grant-options').replaceChildren(...visible.map((p) => {
      const label = node('label'),
        box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = chosen.has(p.id)
      box.onchange = () => {
        if (box.checked) chosen.add(p.id)
        else chosen.delete(p.id)
        count()
      }
      label.append(box, document.createTextNode(' ' + p.displayName))
      if (p.state !== 'published') label.append(node('span', '未上架', 'muted'))
      return label
    }))
    if (!visible.length) $('grant-options').append(node('p', items.length ? '没有匹配项，已选项仍保留。' : '暂无受限插件；公开插件所有人都能用，无需授权。', 'muted'))
    count()
  }
  const count = () => {
    $('grant-count').textContent = `已选 ${grantable().filter((p) => chosen.has(p.id)).length} 个插件`
  }

  /** Opens the dialog for `/api/v1/{organizations|keys|users}/{id}`, titled with who it is. */
  function open(subjectPath, title) {
    action(async () => {
      const current = await json(`${subjectPath}/grants`)
      path = subjectPath
      who = title
      chosen = new Set(current.plugins)
      $('grants-title').textContent = title
      $('grants-error').textContent = ''
      $('grant-search').value = ''
      render()
      $('grants-dialog').showModal()
    })
  }
  $('grant-search').oninput = render
  $('cancel-grants').onclick = () => $('grants-dialog').close()
  $('grants-form').onsubmit = (event) => {
    event.preventDefault()
    action(async () => {
      await json(`${path}/grants`, { plugins: [...chosen] })
      $('grants-dialog').close()
      await reload(`${who} 的插件授权已保存。`)
    }, { errorTarget: 'grants-error' })
  }

  return {
    open,
    clear() {
      chosen = new Set()
      $('grants-dialog').close()
      $('grant-options').replaceChildren()
    },
  }
}
