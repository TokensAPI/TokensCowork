/**
 * The plugin documentation page of the console: pick a plugin, upload Markdown files written
 * elsewhere, replace or delete them. No editor on purpose — the pages are authored outside and
 * uploaded as files. Readers see them at /docs, limited to the plugins they may use.
 */
const MAX_LENGTH = 200_000

/** A page's title: the file's first level-one heading, else its file name without the extension. */
export function docTitle(text, fileName) {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/mu.exec(text)?.[1]?.trim()
  return (heading || fileName.replace(/\.(md|markdown|txt)$/iu, '') || '未命名文档').slice(0, 120)
}

export function docsAdminView({ $, node, button, json, action, formatTime, plugins }) {
  let pluginId = '', items = [], pending = null

  const documentable = () => plugins().filter(plugin => plugin.category !== 'builtin' && plugin.state !== 'deleted')

  function renderOptions() {
    const list = documentable()
    if (!list.some(plugin => plugin.id === pluginId)) pluginId = list[0]?.id ?? ''
    $('docs-plugin').replaceChildren(...list.map(plugin => {
      const option = node('option', `${plugin.displayName || plugin.id}（${plugin.id}）`)
      option.value = plugin.id
      option.selected = plugin.id === pluginId
      return option
    }))
  }

  function render() {
    $('docs-list').replaceChildren(...items.map(doc => {
      const row = document.createElement('tr'), cell = document.createElement('td'), actions = node('div', '', 'row-actions')
      actions.append(
        button('替换', () => pick({ replace: doc })),
        button('删除', () => {
          if (!confirm(`删除文档「${doc.title}」？`)) return
          action(async () => {
            await json(`/api/v1/plugins/${pluginId}/docs/${doc.id}`, undefined, 'DELETE')
            await load()
          }, { success: '文档已删除。' })
        }, 'quiet danger'),
      )
      cell.append(actions)
      row.append(node('td', doc.title), node('td', String(doc.position)), node('td', `${doc.body.length} 字`), node('td', formatTime(doc.updatedAt)), cell)
      return row
    }))
    $('docs-empty').hidden = items.length > 0 || !pluginId
    $('docs-upload').disabled = !pluginId
  }

  async function load() {
    items = pluginId ? (await json(`/api/v1/plugins/${pluginId}/docs`)).items : []
    render()
  }

  // One hidden file input serves both uploading a new page and replacing one.
  function pick(target) {
    pending = target
    $('docs-file').value = ''
    $('docs-file').click()
  }
  $('docs-file').onchange = () => {
    const file = $('docs-file').files?.[0]
    const target = pending
    pending = null
    if (!file || !pluginId) return
    action(async () => {
      const text = await file.text()
      if (!text.trim()) throw new Error('文件是空的。')
      if (text.length > MAX_LENGTH) throw new Error(`文档超过 ${MAX_LENGTH} 字，请拆成多篇。`)
      if (target?.replace) {
        const doc = target.replace
        await json(`/api/v1/plugins/${pluginId}/docs/${doc.id}`, { title: docTitle(text, file.name), body: text, position: doc.position }, 'PUT')
      } else {
        const position = items.reduce((max, doc) => Math.max(max, doc.position + 1), 0)
        await json(`/api/v1/plugins/${pluginId}/docs`, { title: docTitle(text, file.name), body: text, position: Math.min(position, 10_000) }, 'POST')
      }
      await load()
    }, { success: target?.replace ? '文档已替换。' : '文档已上传。' })
  }
  $('docs-upload').onclick = () => pick({})
  $('docs-plugin').onchange = () => {
    pluginId = $('docs-plugin').value
    action(load)
  }

  return {
    async show() {
      renderOptions()
      await load()
    },
    clear() {
      pluginId = ''
      items = []
      pending = null
      $('docs-plugin').replaceChildren()
      $('docs-list').replaceChildren()
    },
  }
}
