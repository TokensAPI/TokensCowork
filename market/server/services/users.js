import { auditStatements } from './audit.js'
import { invalid } from './plugins.js'
import { validOrganizationId, userSearchReady, tokensApiUser } from './organizations.js'
import { userPlugins } from './access.js'

// The user directory: TokensAPI users an administrator grants plugins to directly. TokensAPI owns
// the accounts; the market keeps only the user number and a display name for the console, and a
// grant follows the user whichever organization or Key they happen to use.
const nameOK = value => typeof value === 'string' && value.trim() && value.length <= 200

async function grantsByUser(env, id = null) {
  const { results } = await (id
    ? env.MARKET_DB.prepare("SELECT subject,plugin_id FROM market_grants WHERE kind='user' AND subject=? ORDER BY plugin_id").bind(String(id))
    : env.MARKET_DB.prepare("SELECT subject,plugin_id FROM market_grants WHERE kind='user' ORDER BY plugin_id")).all()
  const grants = new Map()
  for (const row of results) grants.set(Number(row.subject), [...grants.get(Number(row.subject)) ?? [], row.plugin_id])
  return grants
}
const view = (row, grants) => ({ id: row.id, name: row.name, createdAt: row.created_at, plugins: grants.get(row.id) ?? [] })

export async function listUsers(env) {
  const [{ results }, grants] = await Promise.all([
    env.MARKET_DB.prepare('SELECT id,name,created_at FROM market_users ORDER BY name,id').all(),
    grantsByUser(env),
  ])
  return { items: results.map(row => view(row, grants)), searchReady: userSearchReady(env) }
}

// Display names, and the organization TokensAPI currently places each user in, for user numbers
// seen elsewhere in the console (the account a session log reports). The directory's name wins;
// every number is asked of TokensAPI one by one, a few at a time, for its organization (and, outside
// the directory, its name), and each answer -- a user or "no such user" -- is kept for five minutes
// per process. A failed lookup is not kept: a directory user keeps their name with the organization
// left out, anyone else stays unnamed. A name is a convenience, never a reason to fail.
const NAME_TTL = 5 * 60_000, NAME_LIMIT = 100, NAME_CONCURRENCY = 4
const names = new WeakMap()
function nameCache(env) {
  let cache = names.get(env)
  if (!cache || cache.source !== env.MARKET_ORGANIZATIONS) {
    cache = { source: env.MARKET_ORGANIZATIONS, entries: new Map() }
    names.set(env, cache)
  }
  return cache.entries
}
// The TokensAPI user ({ name, organizationId }), null for "no such user", undefined when TokensAPI
// could not answer.
async function upstreamUser(env, id) {
  const cache = nameCache(env), hit = cache.get(id)
  if (hit && hit.expires > Date.now()) return hit.user
  let user
  try { user = await tokensApiUser(env, id) } catch { return undefined }
  if (cache.size >= 4096) cache.clear()
  const value = user ? { name: user.name || null, organizationId: user.organizationId } : null
  cache.set(id, { user: value, expires: Date.now() + NAME_TTL })
  return value
}
// The organization TokensAPI currently places each of these accounts in, for filtering by it:
// id -> organization id, null for "belongs to none", undefined for "TokensAPI has no such user".
// Same lookup, cache and concurrency as the names. Unlike a name, a filter cannot be half right, so
// any account TokensAPI cannot answer for fails the whole question with 503 instead of guessing.
export const ORGANIZATION_FILTER_LIMIT = 200
export async function accountOrganizations(env, ids) {
  if (!userSearchReady(env)) throw invalid('未配置 TokensAPI 用户搜索，无法按组织筛选', 503)
  const owners = new Map()
  for (let i = 0; i < ids.length; i += NAME_CONCURRENCY) {
    const batch = ids.slice(i, i + NAME_CONCURRENCY)
    const found = await Promise.all(batch.map(id => upstreamUser(env, id)))
    if (found.includes(undefined)) throw invalid('暂时查不到组织归属，稍后再试', 503)
    batch.forEach((id, j) => owners.set(id, found[j] ? found[j].organizationId ?? null : undefined))
  }
  return owners
}

export async function userNames(env, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > NAME_LIMIT || !ids.every(validOrganizationId))
    throw invalid(`ids 须为 1-${NAME_LIMIT} 个用户号，以逗号分隔`)
  const wanted = [...new Set(ids)]
  const { results } = await env.MARKET_DB.prepare(`SELECT id,name FROM market_users WHERE id IN (${wanted.map(() => '?').join(',')})`).bind(...wanted).all()
  const directory = new Map(results.map(row => [row.id, row.name]))
  const upstream = new Map()
  if (userSearchReady(env)) {
    for (let i = 0; i < wanted.length; i += NAME_CONCURRENCY) {
      const batch = wanted.slice(i, i + NAME_CONCURRENCY)
      const found = await Promise.all(batch.map(id => upstreamUser(env, id)))
      batch.forEach((id, j) => upstream.set(id, found[j]))
    }
  }
  const orgIds = [...new Set([...upstream.values()].map(user => user?.organizationId).filter(Boolean))]
  const { results: orgs } = orgIds.length
    ? await env.MARKET_DB.prepare(`SELECT id,name FROM market_organizations WHERE id IN (${orgIds.map(() => '?').join(',')})`).bind(...orgIds).all()
    : { results: [] }
  const orgNames = new Map(orgs.map(row => [row.id, row.name]))
  const items = []
  for (const id of wanted) {
    const user = upstream.get(id), name = directory.get(id) ?? user?.name
    if (!name) continue
    // `organization` is null for "belongs to none" and left out when TokensAPI could not say.
    const organization = user === undefined || user === null ? undefined
      : user.organizationId ? { id: user.organizationId, name: orgNames.get(user.organizationId) ?? null } : null
    items.push({ id, name, source: directory.has(id) ? 'directory' : 'tokensapi', ...(organization === undefined ? {} : { organization }) })
  }
  return { items: items.sort((a, b) => a.id - b.id) }
}

async function userRow(env, id) {
  if (!validOrganizationId(id)) throw invalid('用户号无效')
  const row = await env.MARKET_DB.prepare('SELECT id,name,created_at FROM market_users WHERE id=?').bind(id).first()
  if (!row) throw invalid('用户不存在', 404)
  return row
}

export async function getUser(env, id) {
  return view(await userRow(env, id), await grantsByUser(env, id))
}

// What one TokensAPI user actually holds, registered here or not: their name, the organization
// TokensAPI places them in, and each restricted plugin with where it comes from. Nothing is stored.
// When TokensAPI cannot answer, a registered user's own grants are still listed with a notice that
// organization grants are missing; an unregistered user cannot be looked up at all.
export async function userAccess(request, env, id) {
  if (!validOrganizationId(id)) throw invalid('用户号无效')
  const row = await env.MARKET_DB.prepare('SELECT id,name FROM market_users WHERE id=?').bind(id).first()
  let account = null, notice = null
  try { account = await tokensApiUser(env, id) }
  catch (error) {
    if (!row) throw error
    notice = `${error.message}，查不到所属组织，经组织获得的授权未列出。`
  }
  if (!row && !account) throw invalid(`TokensAPI 中没有用户 #${id}`, 404)
  if (row && !account && !notice) notice = 'TokensAPI 中查不到该用户，只列出单独授权。'
  const organizationId = account?.organizationId ?? null
  const [org, plugins] = await Promise.all([
    organizationId ? env.MARKET_DB.prepare('SELECT name,enabled FROM market_organizations WHERE id=?').bind(organizationId).first() : null,
    userPlugins(request, env, id, organizationId),
  ])
  const organization = organizationId
    ? { id: organizationId, name: org?.name ?? null, registered: !!org, enabled: org?.enabled === 1 }
    : null
  return {
    id, name: row?.name ?? account.name, registered: !!row, organization, notice,
    items: plugins.map(item => ({
      id: item.id, displayName: item.displayName,
      sources: [
        ...(item.user ? [{ kind: 'user' }] : []),
        ...(item.organization ? [{ kind: 'organization', id: organizationId, name: organization.name }] : []),
      ],
    })),
  }
}

// Adding a user to the directory, or refreshing the name shown for them.
export async function saveUser(env, id, data, actor) {
  if (!validOrganizationId(id)) throw invalid('用户号无效')
  if (!nameOK(data?.name)) throw invalid('请填写用户名称，最多 200 个字符')
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('INSERT INTO market_users(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name')
      .bind(id, data.name.trim(), Date.now()),
    ...auditStatements(env, 'user.updated', id, {}, actor),
  ])
  return { ok: true }
}

// Removing a user removes every plugin grant they held.
export async function deleteUser(env, id, actor) {
  await userRow(env, id)
  const grants = (await grantsByUser(env, id)).get(id) ?? []
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare("DELETE FROM market_grants WHERE kind='user' AND subject=?").bind(String(id)),
    env.MARKET_DB.prepare('DELETE FROM market_users WHERE id=?').bind(id),
    ...auditStatements(env, 'user.deleted', id, { grantCount: grants.length }, actor),
  ])
  return { ok: true }
}
