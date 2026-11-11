import { bearer, text } from '../http/request.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { allowed, filterRoster } from './access.js'
import { auditStatements } from './audit.js'
import { localizeCatalog } from './catalog-locale-service.js'
import { resolveIdentity } from './organizations.js'
import { catalogRoster, invalid, pluginRow } from './plugins.js'

// Plugin documentation: Markdown pages a platform administrator attaches to a plugin. Who may read
// a page is never stored with it — a reader sees the pages of exactly the plugins the catalog shows
// the same Key, through the same access decision (services/access.js), so the two cannot disagree.

/** Largest Markdown page accepted, in characters; the request body limit is set from it. */
export const MAX_DOC_LENGTH = 200_000
/** Request body limit for the doc routes: the page plus its JSON envelope. */
export const DOC_BODY_LIMIT = MAX_DOC_LENGTH * 4 + 4096
const MAX_POSITION = 10_000

const docId = segment => /^[1-9][0-9]{0,15}$/u.test(segment ?? '') && Number.isSafeInteger(Number(segment)) ? Number(segment) : 0
const view = row => ({ id: row.id, title: row.title, body: row.body, position: row.position, updatedAt: row.updated_at })

function fields(data) {
  if (!text(data?.title, 120)) throw invalid('请填写 1-120 个字符的文档标题')
  if (typeof data.body !== 'string' || !data.body.trim() || data.body.length > MAX_DOC_LENGTH) throw invalid(`文档内容不能为空，且不超过 ${MAX_DOC_LENGTH} 个字符`)
  const position = data.position ?? 0
  if (!Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION) throw invalid('排序须为 0-10000 的整数')
  return { title: data.title.trim(), body: data.body, position }
}

async function existingPlugin(env, pluginId) {
  if (!await pluginRow(env, pluginId)) throw invalid('插件不存在', 404)
}

/* ----------------------------- 平台管理员 ----------------------------- */

export async function listPluginDocs(env, pluginId) {
  await existingPlugin(env, pluginId)
  const { results } = await env.MARKET_DB.prepare('SELECT * FROM market_plugin_docs WHERE plugin_id=? ORDER BY position,id').bind(pluginId).all()
  return { items: results.map(view) }
}

export async function createPluginDoc(env, pluginId, data, actor) {
  const doc = fields(data)
  await existingPlugin(env, pluginId)
  const row = await env.MARKET_DB.prepare('INSERT INTO market_plugin_docs(plugin_id,title,body,position,updated_at) VALUES(?,?,?,?,?) RETURNING *')
    .bind(pluginId, doc.title, doc.body, doc.position, Date.now()).first()
  await env.MARKET_DB.batch(auditStatements(env, 'plugin.doc.saved', `${pluginId}:${row.id}`, { created: true }, actor))
  return view(row)
}

// The payload is checked before the page is looked up, so a malformed write never reveals
// whether a page exists.
export async function updatePluginDoc(env, pluginId, segment, data, actor) {
  const doc = fields(data)
  const id = docId(segment)
  if (!id) throw invalid('文档不存在', 404)
  const row = await env.MARKET_DB.prepare('UPDATE market_plugin_docs SET title=?,body=?,position=?,updated_at=? WHERE id=? AND plugin_id=? RETURNING *')
    .bind(doc.title, doc.body, doc.position, Date.now(), id, pluginId).first()
  if (!row) throw invalid('文档不存在', 404)
  await env.MARKET_DB.batch(auditStatements(env, 'plugin.doc.saved', `${pluginId}:${id}`, { created: false }, actor))
  return view(row)
}

export async function deletePluginDoc(env, pluginId, segment, actor) {
  const id = docId(segment)
  if (!id || !await env.MARKET_DB.prepare('SELECT 1 FROM market_plugin_docs WHERE id=? AND plugin_id=?').bind(id, pluginId).first()) throw invalid('文档不存在', 404)
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM market_plugin_docs WHERE id=? AND plugin_id=?').bind(id, pluginId),
    ...auditStatements(env, 'plugin.doc.deleted', `${pluginId}:${id}`, {}, actor),
  ])
  return { ok: true }
}

/* ----------------------------- 读者 ----------------------------- */

/**
 * A reader signs in with their TokensAPI Key, the same credential the desktop catalog uses. The
 * Key must be one the market recognizes — registered here, or naming a TokensAPI organization or
 * user — so an anonymous caller is refused instead of being shown the public pages.
 */
async function requireReader(request, env) {
  const key = bearer(request)
  if (!key) throw invalid('请先登录', 401)
  if (await env.MARKET_DB.prepare('SELECT 1 FROM market_keys WHERE fingerprint=?').bind(await fingerprint(key, env.MARKET_HMAC_SECRET)).first()) return
  let identity
  try { identity = await resolveIdentity(key, env) } catch { throw invalid('暂时无法验证 Key，请稍后重试', 503) }
  if (!identity?.organization && !identity?.user) throw invalid('Key 无效', 401)
}

/** The plugins this Key may see, each with the titles of its pages. */
export async function readerPlugins(request, env, locale) {
  await requireReader(request, env)
  const roster = await filterRoster(request, env, await catalogRoster(env))
  const items = await localizeCatalog(roster.items, env, locale)
  const { results } = await env.MARKET_DB.prepare('SELECT id,plugin_id,title FROM market_plugin_docs ORDER BY position,id').all()
  const titles = new Map()
  for (const row of results) {
    if (!titles.has(row.plugin_id)) titles.set(row.plugin_id, [])
    titles.get(row.plugin_id).push({ id: row.id, title: row.title })
  }
  return {
    items: items.map(item => ({ id: item.id, displayName: item.displayName, summary: item.summary, docs: titles.get(item.id) ?? [] })),
  }
}

/** One plugin's pages in full. A plugin the Key may not see answers exactly like one that does not exist. */
export async function readerPluginDocs(request, env, pluginId) {
  await requireReader(request, env)
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(pluginId) || !await allowed(request, env, pluginId)) throw invalid('not found', 404)
  const { results } = await env.MARKET_DB.prepare('SELECT * FROM market_plugin_docs WHERE plugin_id=? ORDER BY position,id').bind(pluginId).all()
  return { pluginId, items: results.map(view) }
}
