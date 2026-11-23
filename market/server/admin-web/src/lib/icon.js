/**
 * The bytes a picked icon file is uploaded as (components/IconDialog.vue). There is one
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
