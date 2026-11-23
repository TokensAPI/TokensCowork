import { auditStatements } from './audit.js'
import { imageType } from './icons.js'
import { invalid, pluginRow } from './plugins.js'

// Images for plugin documentation pages. The platform administrator uploads the raw file (PNG,
// JPEG or WebP, told by its bytes, never by its name or Content-Type); it is kept in the market
// database beside the pages, like icons, but never served publicly: readers fetch it through
// /v1/docs/{pluginId}/images/{id} under the pages' own access decision (services/docs.js).

/**
 * Largest image accepted, in bytes. The market's front proxy and its Node server both refuse
 * request bodies over 1 MiB, and the file is sent as-is, so this leaves room for nothing else;
 * a documentation screenshot is typically 150-450 KB.
 */
export const MAX_DOC_IMAGE_BYTES = 1000 * 1024
/** Images one plugin's documentation may hold. */
export const MAX_DOC_IMAGES = 200

const IMAGE_ID = /^[a-f0-9]{32}$/u
const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')

/** The address a page uses for an image, and the only image address the docs center loads. */
export const docImagePath = (pluginId, id) => `/v1/docs/${encodeURIComponent(pluginId)}/images/${id}`
const view = row => ({ id: row.id, name: row.name, contentType: row.content_type, bytes: row.bytes,
  url: docImagePath(row.plugin_id, row.id), createdAt: row.created_at })

/** A file name as it may be shown: its last path segment, without control characters, at most 200 characters. */
function fileName(value) {
  const name = String(value ?? '').split(/[\\/]/u).pop().replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return name.slice(0, 200) || 'image'
}

async function existingPlugin(env, pluginId) {
  if (!await pluginRow(env, pluginId)) throw invalid('插件不存在', 404)
}

/** GET /api/v1/plugins/{id}/docs/images: the plugin's images, newest first, without their bytes. */
export async function listDocImages(env, pluginId) {
  await existingPlugin(env, pluginId)
  const { results } = await env.MARKET_DB.prepare('SELECT id,plugin_id,name,content_type,bytes,created_at FROM market_plugin_doc_images WHERE plugin_id=? ORDER BY created_at DESC,id')
    .bind(pluginId).all()
  return { items: results.map(view) }
}

/**
 * POST /api/v1/plugins/{id}/docs/images?name=<file name>, body: the image file. The same bytes
 * uploaded again for the same plugin answer with the image already stored (`existing: true`), so
 * uploading a page again with its pictures does not pile up copies.
 */
export async function uploadDocImage(env, pluginId, name, file, actor) {
  if (!file.length) throw invalid('请上传图片文件')
  const contentType = imageType(file)
  if (!contentType) throw invalid('只支持 PNG、JPEG 或 WebP 图片')
  await existingPlugin(env, pluginId)
  const sha256 = hex(await crypto.subtle.digest('SHA-256', file))
  const same = await env.MARKET_DB.prepare('SELECT id,plugin_id,name,content_type,bytes,created_at FROM market_plugin_doc_images WHERE plugin_id=? AND sha256=?')
    .bind(pluginId, sha256).first()
  if (same) return { ...view(same), existing: true }
  const { count } = await env.MARKET_DB.prepare('SELECT COUNT(*) AS count FROM market_plugin_doc_images WHERE plugin_id=?').bind(pluginId).first()
  if (count >= MAX_DOC_IMAGES) throw invalid(`每个插件的文档最多 ${MAX_DOC_IMAGES} 张图片，请先删除不用的图片`, 409)
  const row = { id: hex(crypto.getRandomValues(new Uint8Array(16))), plugin_id: pluginId, name: fileName(name), content_type: contentType,
    bytes: file.length, created_at: Date.now() }
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('INSERT INTO market_plugin_doc_images(id,plugin_id,name,content_type,bytes,sha256,data,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(row.id, pluginId, row.name, contentType, file.length, sha256, file, row.created_at),
    ...auditStatements(env, 'plugin.doc.image.uploaded', `${pluginId}:${row.id}`, { bytes: file.length, contentType }, actor),
  ])
  return { ...view(row), existing: false }
}

/** DELETE /api/v1/plugins/{id}/docs/images/{imageId}. A page still pointing at it shows the image's alt text. */
export async function deleteDocImage(env, pluginId, imageId, actor) {
  if (!IMAGE_ID.test(imageId ?? '') || !await env.MARKET_DB.prepare('SELECT 1 FROM market_plugin_doc_images WHERE id=? AND plugin_id=?').bind(imageId, pluginId).first())
    throw invalid('图片不存在', 404)
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM market_plugin_doc_images WHERE id=? AND plugin_id=?').bind(imageId, pluginId),
    ...auditStatements(env, 'plugin.doc.image.deleted', `${pluginId}:${imageId}`, {}, actor),
  ])
  return { ok: true }
}

/** One image with its bytes, for the reader route; null when the plugin has no such image. */
export async function docImageRow(env, pluginId, imageId) {
  if (!IMAGE_ID.test(imageId ?? '')) return null
  return await env.MARKET_DB.prepare('SELECT content_type,bytes,data FROM market_plugin_doc_images WHERE id=? AND plugin_id=?').bind(imageId, pluginId).first() ?? null
}
