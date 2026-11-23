/**
 * The plugin documentation page of the console: pick a plugin, upload Markdown files written
 * elsewhere, replace or delete them. No editor on purpose — the pages are authored outside and
 * uploaded as files. Readers see them at /docs, limited to the plugins they may use.
 */
const MAX_LENGTH = 200_000
/** Largest image the market accepts (services/doc-images.js MAX_DOC_IMAGE_BYTES). */
const MAX_IMAGE_BYTES = 1000 * 1024
const IMAGE_FILE = /\.(png|jpe?g|webp)$/iu
// `![alt](target "title")`: the target as written, angle brackets included, and what follows it.
const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)((?:\s+"[^"\n]*")?\s*)\)/gu
// A target with a scheme, a root or only a fragment is not a file beside the page.
const relative = target => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(target)
const unwrap = target => target.replace(/^<(.*)>$/u, '$1')
/** The file a relative target names, compared case-blind: `./images/Step%201.png` → `step 1.png`. */
export function imageFileName(target) {
  const last = unwrap(target).split(/[?#]/u)[0].split('/').pop()
  try { return decodeURIComponent(last).toLowerCase() } catch { return last.toLowerCase() }
}

/** The relative images a page points at, each file once, in order: [{ target, name }]. */
export function imageReferences(text) {
  const seen = new Map()
  for (const [, , target] of String(text).matchAll(IMAGE)) {
    if (!relative(unwrap(target))) continue
    const name = imageFileName(target)
    if (name && !seen.has(name)) seen.set(name, { target: unwrap(target), name })
  }
  return [...seen.values()]
}

/** The page with every relative image whose file was uploaded pointed at its new address (`uploaded`: name → url). */
export function replaceImageReferences(text, uploaded) {
  return String(text).replace(IMAGE, (whole, alt, target, rest) => {
    if (!relative(unwrap(target))) return whole
    const url = uploaded.get(imageFileName(target))
    return url ? `![${alt}](${url}${rest})` : whole
  })
}

/** A page's title: the file's first level-one heading, else its file name without the extension. */
export function docTitle(text, fileName) {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/mu.exec(text)?.[1]?.trim()
  return (heading || fileName.replace(/\.(md|markdown|txt)$/iu, '') || '未命名文档').slice(0, 120)
}

export function docsAdminView({ $, node, rowActions, confirmAction, json, action, reload, formatTime, plugins, icons }) {
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
      const row = document.createElement('tr'), cell = document.createElement('td')
      cell.append(rowActions(doc.title, { label: '替换', run: () => pick({ replace: doc }) }, [
        { label: '删除', danger: true, run: async () => {
          if (!(await confirmAction({ title: `删除文档「${doc.title}」？`, ok: '删除文档',
            text: '删除后用户在文档中心再也看不到这篇文档，不可恢复；这个插件的其他文档和图标不受影响。' }))) return
          action(async () => {
            await json(`/api/v1/plugins/${pluginId}/docs/${doc.id}`, undefined, 'DELETE')
            await load()
          }, { success: '文档已删除。' })
        } },
      ]))
      row.append(node('td', doc.title, 'fw-medium text-break'), node('td', String(doc.position)), node('td', `${doc.body.length} 字`),
        node('td', formatTime(doc.updatedAt), 'text-secondary text-nowrap'), cell)
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
  // Changing it opens the same icon dialog as the plugin page, so there is one editor for one image.
  const onIconSaved = async (message) => {
    await reload(message)
    showIcon()
  }
  function showIcon() {
    const img = $('docs-icon')
    img.hidden = true
    $('docs-icon-edit').disabled = !pluginId
    if (!pluginId) return
    img.onload = () => { img.hidden = false }
    img.onerror = () => { img.hidden = true }
    img.src = `/v1/icons/${encodeURIComponent(pluginId)}?t=${Date.now()}`
  }
  $('docs-icon-edit').onclick = () => {
    const plugin = plugins().find(item => item.id === pluginId)
    if (plugin) icons.open(plugin, onIconSaved)
  }

  // One image, sent as the file itself; the answer carries the address the page should use.
  async function uploadImage(file) {
    const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/docs/images?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/octet-stream' }, body: file,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`图片「${file.name}」：${data.error || '上传失败，请稍后重试。'}`)
    return data.url
  }

  // One hidden file input serves both uploading a new page and replacing one. Together with the
  // page the administrator may pick the images it uses; anything it points at that was not picked
  // is named before uploading, and the page is saved only after every picked image is in.
  function pick(target) {
    pending = target
    $('docs-file').value = ''
    $('docs-file').click()
  }
  const refuse = message => action(async () => { throw new Error(message) })
  $('docs-file').onchange = async () => {
    const files = [...($('docs-file').files ?? [])]
    const target = pending
    pending = null
    if (!files.length || !pluginId) return
    const pictures = files.filter(file => IMAGE_FILE.test(file.name))
    const pages = files.filter(file => !IMAGE_FILE.test(file.name))
    if (pages.length !== 1) return refuse(pages.length ? '一次只能上传一篇文档，图片可以多张。' : '请同时选上要上传的 Markdown 文件。')
    const file = pages[0]
    const names = new Map()
    for (const picture of pictures) {
      if (picture.size > MAX_IMAGE_BYTES) return refuse(`图片「${picture.name}」超过 ${MAX_IMAGE_BYTES / 1024} KB，请压缩后再上传。`)
      const name = imageFileName(picture.name)
      if (names.has(name)) return refuse(`选了两张同名的图片「${picture.name}」，请改名后再上传。`)
      names.set(name, picture)
    }
    const text = await file.text()
    if (!text.trim()) return refuse('文件是空的。')
    if (text.length > MAX_LENGTH) return refuse(`文档超过 ${MAX_LENGTH} 字，请拆成多篇。`)
    const missing = imageReferences(text).filter(ref => !names.has(ref.name))
    if (missing.length && !(await confirmAction({ title: `正文引用的 ${missing.length} 张图片没有选`, ok: '仍然上传', danger: false,
      text: `${missing.slice(0, 10).map(ref => ref.target).join('、')}${missing.length > 10 ? ` 等 ${missing.length} 张` : ''}。`
        + '这些图片在文档中心只会显示成文字。可以取消后连同图片一起重新选择。' }))) return
    action(async () => {
      const uploaded = new Map()
      for (const [name, picture] of names) uploaded.set(name, await uploadImage(picture))
      const body = replaceImageReferences(text, uploaded)
      if (body.length > MAX_LENGTH) throw new Error(`文档超过 ${MAX_LENGTH} 字，请拆成多篇。`)
      if (target?.replace) {
        const doc = target.replace
        await json(`/api/v1/plugins/${pluginId}/docs/${doc.id}`, { title: docTitle(text, file.name), body, position: doc.position }, 'PUT')
      } else {
        const position = items.reduce((max, doc) => Math.max(max, doc.position + 1), 0)
        await json(`/api/v1/plugins/${pluginId}/docs`, { title: docTitle(text, file.name), body, position: Math.min(position, 10_000) }, 'POST')
      }
      await load()
    }, { success: `${target?.replace ? '文档已替换' : '文档已上传'}${names.size ? `，含 ${names.size} 张图片` : ''}。` })
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
