import { auditStatements } from './audit.js'
import { invalid, pluginRow } from './plugins.js'

// Plugin icons. The desktop market draws a catalog item's media.icon (the field upstream catalogs
// use) and only accepts PNG, JPEG and WebP from the catalog's own origin, re-encoding them to a
// fixed-size PNG; the docs center shows the same image. Icons are public: they say no more than
// the plugin's name does, and the catalog only lists them for plugins the caller may see.

/** Largest icon accepted, in bytes; the desktop refuses images over 2 MB, icons need far less. */
export const MAX_ICON_BYTES = 256 * 1024
/** Request body limit for the upload: the image as base64 plus its JSON envelope. */
export const ICON_BODY_LIMIT = Math.ceil(MAX_ICON_BYTES / 3) * 4 + 1024

const SIGNATURES = {
  'image/png': bytes => bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, i) => bytes[i] === value),
  'image/jpeg': bytes => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': bytes => bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP',
}

function decode(data) {
  const contentType = data?.contentType
  if (!Object.hasOwn(SIGNATURES, contentType)) throw invalid('图标只支持 PNG、JPEG 或 WebP')
  if (typeof data.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data.data)) throw invalid('图标内容无效')
  const bytes = Uint8Array.from(atob(data.data), char => char.charCodeAt(0))
  if (bytes.length > MAX_ICON_BYTES) throw invalid(`图标不能超过 ${MAX_ICON_BYTES / 1024} KB`)
  // The declared type must be what the bytes are; nothing else is ever served.
  if (!SIGNATURES[contentType](bytes)) throw invalid('图标内容与格式不符')
  return { contentType, bytes }
}

/** PUT /api/v1/plugins/{id}/icon { contentType, data: base64 } */
export async function setPluginIcon(env, pluginId, data, actor) {
  const icon = decode(data)
  if (!await pluginRow(env, pluginId)) throw invalid('插件不存在', 404)
  const now = Date.now()
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare(`INSERT INTO market_plugin_icons(plugin_id,content_type,data,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(plugin_id) DO UPDATE SET content_type=excluded.content_type,data=excluded.data,updated_at=excluded.updated_at`)
      .bind(pluginId, icon.contentType, icon.bytes, now),
    ...auditStatements(env, 'plugin.icon.updated', pluginId, { bytes: icon.bytes.length }, actor),
  ])
  return { ok: true, updatedAt: now }
}

/** DELETE /api/v1/plugins/{id}/icon */
export async function deletePluginIcon(env, pluginId, actor) {
  if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_plugin_icons WHERE plugin_id=?').bind(pluginId).first()) throw invalid('这个插件没有图标', 404)
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM market_plugin_icons WHERE plugin_id=?').bind(pluginId),
    ...auditStatements(env, 'plugin.icon.deleted', pluginId, {}, actor),
  ])
  return { ok: true }
}

/** Which plugins have an icon, and since when (the version in its address). */
export async function iconVersions(env) {
  const { results } = await env.MARKET_DB.prepare('SELECT plugin_id,updated_at FROM market_plugin_icons').all()
  return new Map(results.map(row => [row.plugin_id, row.updated_at]))
}

/** The icon's address. Versioned, so a replaced icon is fetched again while an unchanged one stays cached. */
export const iconPath = (pluginId, version) => `/v1/icons/${encodeURIComponent(pluginId)}?v=${version}`

/** GET /v1/icons/{pluginId}: the image itself, or 404. */
export async function servePluginIcon(env, pluginId) {
  const row = /^[a-z0-9][a-z0-9-]{0,79}$/u.test(pluginId)
    ? await env.MARKET_DB.prepare('SELECT content_type,data FROM market_plugin_icons WHERE plugin_id=?').bind(pluginId).first()
    : null
  if (!row) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
  return new Response(row.data, { status: 200, headers: {
    'content-type': row.content_type,
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'cross-origin',
  } })
}
