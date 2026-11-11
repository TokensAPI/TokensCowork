import { bearer, text } from '../http/request.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { allowed, filterRoster } from './access.js'
import { auditStatements } from './audit.js'
import { localizeCatalog } from './catalog-locale-service.js'
import { isPlatform, resolvePrincipal } from './auth.js'
import { resolveIdentity } from './organizations.js'
import { catalogRoster, invalid, pluginRow, productComponents } from './plugins.js'

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
 *
 * Without a Key, the platform administrator's console session (the console links here) reads as
 * an administrator: every published plugin, since the administrator manages all of them. An
 * organization administrator's session is not enough. A Bearer header always decides on its own.
 * @returns {Promise<{ admin: boolean }>}
 */
async function requireReader(request, env) {
  const key = bearer(request)
  if (!key) {
    if (isPlatform(await resolvePrincipal(request, env))) return { admin: true }
    throw invalid('请先登录', 401)
  }
  if (await env.MARKET_DB.prepare('SELECT 1 FROM market_keys WHERE fingerprint=?').bind(await fingerprint(key, env.MARKET_HMAC_SECRET)).first()) return { admin: false }
  let identity
  try { identity = await resolveIdentity(key, env) } catch { throw invalid('暂时无法验证 Key，请稍后重试', 503) }
  if (!identity?.organization && !identity?.user) throw invalid('Key 无效', 401)
  return { admin: false }
}

/** Every published market plugin; built-in components belong to the application, as in the catalog. */
async function allPlugins(request, env) {
  const [roster, components] = await Promise.all([catalogRoster(env), productComponents(request, env)])
  const ids = new Set(components.items.map(item => item.id))
  const packages = new Set(components.items.map(item => item.package).filter(Boolean))
  return roster.items.filter(item => item.category !== 'builtin' && !ids.has(item.id) && !packages.has(item.package))
}

/** The plugins this reader may see, each with the titles of its pages. */
export async function readerPlugins(request, env, locale) {
  const reader = await requireReader(request, env)
  const visible = reader.admin ? await allPlugins(request, env) : (await filterRoster(request, env, await catalogRoster(env))).items
  const items = await localizeCatalog(visible, env, locale)
  const { results } = await env.MARKET_DB.prepare('SELECT id,plugin_id,title FROM market_plugin_docs ORDER BY position,id').all()
  const titles = new Map()
  for (const row of results) {
    if (!titles.has(row.plugin_id)) titles.set(row.plugin_id, [])
    titles.get(row.plugin_id).push({ id: row.id, title: row.title })
  }
  return {
    admin: reader.admin,
    items: items.map(item => ({ id: item.id, displayName: item.displayName, summary: item.summary, docs: titles.get(item.id) ?? [] })),
  }
}

/* ── One-time sign-in codes ─────────────────────────────
 * TokensCowork opens the docs center in the browser already signed in, without putting the Key in
 * the address: the desktop market service trades the Key for a code that lives 60 seconds and works
 * once, opens /docs?code=…, and the page redeems the code for the Key it keeps in that tab. The
 * codes live in this process's memory only; the market runs as one Node process, and a restart
 * merely voids the links nobody has opened yet.
 */
const CODE_TTL = 60_000
const MAX_CODES = 2000
const codes = new Map()
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

function purgeCodes(now) {
  for (const [code, entry] of codes) if (entry.expires <= now) codes.delete(code)
  while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value)
}

/** POST /v1/docs/codes with the reader's Key: a code for one signed-in visit. */
export async function createDocsCode(request, env) {
  const reader = await requireReader(request, env)
  if (reader.admin) throw invalid('管理员请从后台进入文档中心')
  const now = Date.now()
  purgeCodes(now)
  const code = hex(crypto.getRandomValues(new Uint8Array(32)))
  codes.set(code, { key: bearer(request), expires: now + CODE_TTL })
  return { code, expiresIn: CODE_TTL / 1000 }
}

/** POST /v1/docs/codes/redeem { code }: the Key, once. An unknown, used or expired code is one answer. */
export function redeemDocsCode(data) {
  const code = typeof data?.code === 'string' && /^[a-f0-9]{64}$/u.test(data.code) ? data.code : ''
  const entry = code ? codes.get(code) : undefined
  if (code) codes.delete(code)
  if (!entry || entry.expires <= Date.now()) throw invalid('登录链接已失效，请回到 TokensCowork 重新打开', 404)
  return { key: entry.key }
}

/** One plugin's pages in full. A plugin the reader may not see answers exactly like one that does not exist. */
export async function readerPluginDocs(request, env, pluginId) {
  const reader = await requireReader(request, env)
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(pluginId)) throw invalid('not found', 404)
  const visible = reader.admin ? (await allPlugins(request, env)).some(item => item.id === pluginId) : await allowed(request, env, pluginId)
  if (!visible) throw invalid('not found', 404)
  const { results } = await env.MARKET_DB.prepare('SELECT * FROM market_plugin_docs WHERE plugin_id=? ORDER BY position,id').bind(pluginId).all()
  return { pluginId, items: results.map(view) }
}
