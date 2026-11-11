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
    showIcon()
  }

  // The icon preview reads the public address; a plugin without an icon answers 404 and the preview hides.
  function showIcon() {
    const img = $('docs-icon')
    img.hidden = true
    $('docs-icon-upload').disabled = !pluginId
    $('docs-icon-remove').disabled = !pluginId
    if (!pluginId) return
    img.onload = () => { img.hidden = false }
    img.onerror = () => { img.hidden = true }
    img.src = `/v1/icons/${encodeURIComponent(pluginId)}?t=${Date.now()}`
  }
  $('docs-icon-upload').onclick = () => { $('docs-icon-file').value = ''; $('docs-icon-file').click() }
  $('docs-icon-file').onchange = () => {
    const file = $('docs-icon-file').files?.[0]
    if (!file || !pluginId) return
    action(async () => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('图标只支持 PNG、JPEG 或 WebP。')
      if (file.size > 256 * 1024) throw new Error('图标不能超过 256 KB。')
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      await json(`/api/v1/plugins/${pluginId}/icon`, { contentType: file.type, data: btoa(binary) }, 'PUT')
      showIcon()
    }, { success: '图标已更新，插件市场和文档中心会显示新图标。' })
  }
  $('docs-icon-remove').onclick = () => {
    if (!pluginId || !confirm('移除这个插件的图标？')) return
    action(async () => {
      await json(`/api/v1/plugins/${pluginId}/icon`, undefined, 'DELETE')
      showIcon()
    }, { success: '图标已移除。' })
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
  // The docs center reads this console session as the administrator and shows every plugin.
  $('docs-open-center').onclick = () => window.open(`/docs?admin#/${pluginId ? encodeURIComponent(pluginId) : ''}`, '_blank', 'noopener')
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
