/**
 * The plugin icon dialog, opened from a plugin card and from the documentation page. There is one
 * icon per plugin, stored by the market and served at /v1/icons/{id}: the console, the docs center
 * and the desktop market's cards all draw that same image.
 *
 * The server keeps only PNG, JPEG or WebP up to 256 KB, the formats the desktop accepts. Any other
 * image the browser can draw (GIF, SVG, BMP, AVIF, ICO…), or one too large, is redrawn here into a
 * PNG no wider than 512 pixels before it is uploaded, so the administrator can pick any common file.
 */
export const MAX_ICON_BYTES = 256 * 1024
const KEPT = ['image/png', 'image/jpeg', 'image/webp']
const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/iu

const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

// The console's CSP allows images from itself and data: URLs only (no blob:), so a picked file is
// read and previewed as a data: URL.
const dataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = () => reject(new Error('无法读取这个文件。'))
  reader.readAsDataURL(blob)
})

async function draw(file) {
  const img = new Image()
  img.src = await dataUrl(file)
  try {
    await img.decode()
  } catch {
    throw new Error('无法读取这张图片，请换一个文件。')
  }
  return img
}

/** The bytes to upload for a picked file: kept as they are when the server takes them, otherwise redrawn as PNG. */
export async function prepareIcon(file) {
  if (!file.type.startsWith('image/') && !IMAGE_NAME.test(file.name)) throw new Error('请选择图片文件。')
  if (file.size > MAX_SOURCE_BYTES) throw new Error('图片不能超过 10 MB。')
  const img = await draw(file)
  // An SVG without its own size reports 0; draw it at the largest edge allowed.
  const width = img.naturalWidth || 512, height = img.naturalHeight || 512
  if (KEPT.includes(file.type) && file.size <= MAX_ICON_BYTES) return { blob: file, contentType: file.type, width, height, converted: false }
  for (const edge of [512, 256, 128]) {
    const scale = Math.min(1, edge / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('无法转换这张图片，请换成 PNG、JPEG 或 WebP。')
    if (blob.size <= MAX_ICON_BYTES) return { blob, contentType: 'image/png', width: canvas.width, height: canvas.height, converted: true }
  }
  throw new Error('图片转换后仍超过 256 KB，请换一张更简单的图。')
}

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function iconDialog({ $, json, action, isBusy, confirmAction }) {
  let plugin = null, chosen = null, hasIcon = false, done = null

  function show(img, empty, src) {
    img.hidden = true
    empty.hidden = false
    if (!src) return
    img.onload = () => { img.hidden = false; empty.hidden = true }
    img.onerror = () => { img.hidden = true; empty.hidden = false }
    img.src = src
  }
  function refresh() {
    $('icon-save').disabled = !chosen
    $('icon-remove').disabled = !hasIcon
    $('icon-pick').textContent = chosen || hasIcon ? '换一张图片' : '选择图片'
  }
  // The current icon is read where everyone reads it; a plugin without one answers 404.
  function loadCurrent() {
    hasIcon = false
    refresh()
    const img = $('icon-current')
    show(img, $('icon-current-empty'), `/v1/icons/${encodeURIComponent(plugin.id)}?t=${Date.now()}`)
    img.addEventListener('load', () => { hasIcon = true; refresh() }, { once: true })
  }

  /** Opens the dialog for one market plugin; `after(message)` runs once a change is saved. */
  function open(target, after) {
    if (isBusy()) return
    plugin = target
    done = after
    chosen = null
    $('icon-form').reset()
    $('icon-title').textContent = `插件图标 · ${target.displayName || target.id}`
    $('icon-package').textContent = target.package || target.id
    $('icon-error').textContent = ''
    $('icon-file-info').textContent = ''
    show($('icon-next'), $('icon-next-empty'), '')
    loadCurrent()
    $('icon-dialog').showModal()
  }

  $('icon-pick').onclick = () => {
    if (isBusy()) return
    $('icon-file').value = ''
    $('icon-file').click()
  }
  $('icon-file').onchange = async () => {
    const file = $('icon-file').files?.[0]
    if (!file) return
    $('icon-error').textContent = ''
    chosen = null
    show($('icon-next'), $('icon-next-empty'), '')
    $('icon-file-info').textContent = `${file.name} · ${size(file.size)}`
    try {
      chosen = await prepareIcon(file)
    } catch (error) {
      $('icon-error').textContent = error.message
      $('icon-file-info').textContent = ''
      refresh()
      return
    }
    show($('icon-next'), $('icon-next-empty'), await dataUrl(chosen.blob))
    $('icon-file-info').textContent = `${file.name} · ${chosen.width}×${chosen.height} · ` +
      (chosen.converted ? `已转换为 PNG（${size(chosen.blob.size)}）` : `${chosen.contentType.slice(6).toUpperCase()} ${size(chosen.blob.size)}，原样保存`)
    refresh()
  }
  $('icon-form').onsubmit = (event) => {
    event.preventDefault()
    if (!chosen || !plugin) return
    const target = plugin, icon = chosen
    action(async () => {
      await json(`/api/v1/plugins/${encodeURIComponent(target.id)}/icon`, { contentType: icon.contentType, data: await base64(icon.blob) }, 'PUT')
      close()
      await done?.(`${target.displayName || target.id} 的图标已更新，插件市场和文档中心显示同一张图。`)
    }, { errorTarget: 'icon-error' })
  }
  $('icon-remove').onclick = async () => {
    if (!plugin || !hasIcon || isBusy()) return
    if (!(await confirmAction({ title: `移除「${plugin.displayName || plugin.id}」的图标？`, ok: '移除图标',
      text: '插件市场卡片、文档中心和后台都会改回显示首字，直到重新上传图标。' }))) return
    const target = plugin
    action(async () => {
      await json(`/api/v1/plugins/${encodeURIComponent(target.id)}/icon`, undefined, 'DELETE')
      close()
      await done?.(`${target.displayName || target.id} 的图标已移除。`)
    }, { errorTarget: 'icon-error' })
  }
  function close() {
    $('icon-dialog').close()
    chosen = null
  }
  $('cancel-icon').onclick = () => { if (!isBusy()) close() }
  $('icon-dialog').addEventListener('cancel', (event) => {
    event.preventDefault()
    if (!isBusy()) close()
  })

  return { open, clear: close }
}
