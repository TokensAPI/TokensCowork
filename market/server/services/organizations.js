import { createTokensApiOrganizations } from '../integrations/tokensapi-organizations.js'
import { auditStatements } from './audit.js'
import { fingerprint } from '../security/key-fingerprint.js'
// Dependency injection is retained for isolated tests. HTTP configuration is server-only.
const provider=env=>env.MARKET_ORGANIZATIONS??createTokensApiOrganizations(env)
export const validOrganizationId = value => Number.isSafeInteger(value) && value > 0
export function organizationProviderReady(env) {
  return typeof provider(env)?.resolveOrganization === 'function'
}
export function organizationListReady(env) {
  return typeof provider(env)?.listOrganizations === 'function'
}
// Whether TokensAPI account login can be offered at all. Both calls are needed: one names the
// person, the other names their organization and the role TokensAPI gives them in it.
export function organizationSessionReady(env) {
  const source = provider(env)
  return typeof source?.resolveAccount === 'function' && typeof source?.resolveMyOrg === 'function'
}
async function bounded(operation) {
  let timer
  try {
    return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('organization provider timeout')),8000)})])
  } finally {clearTimeout(timer)}
}
function validOrganization(org) {
  return org && validOrganizationId(org.id) && typeof org.name === 'string' && org.name.trim() && org.name.length<=200
}
export async function syncOrganizations(env, actor) {
  const source=provider(env)
  if(typeof source?.listOrganizations!=='function') throw new Error('organization listing unavailable')
  const organizations=await bounded(()=>source.listOrganizations())
  if(!Array.isArray(organizations) || organizations.length>10000 || !organizations.every(validOrganization)
    || new Set(organizations.map(o=>o.id)).size!==organizations.length) throw new Error('invalid organization list')
  // Do not reactivate locally disabled organizations or delete grants absent from one sync.
  await env.MARKET_DB.batch([
    ...organizations.map(org=>env.MARKET_DB.prepare(`INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name`).bind(org.id,org.name.trim())),
    ...auditStatements(env, 'organizations.synced', '', { count: organizations.length }, actor),
  ])
  return organizations.length
}
export async function resolveOrganization(apiKey, env) {
  if (!organizationProviderReady(env)) throw new Error('organization provider unavailable')
  const organization = await bounded(()=>provider(env).resolveOrganization(apiKey))
  if (organization === null) return null // Invalid/revoked Key or no organization.
  if (!validOrganization(organization)) throw new Error('invalid organization response')
  return { id: organization.id, name: organization.name }
}
const validUser = user => user && validOrganizationId(user.id) && typeof user.name === 'string' && user.name.length <= 200
// Who a Key belongs to is asked on every catalog and Registry request a user or organization
// grant could change, so each answer is kept for a minute per process: grants and switches still
// apply at once, only a change of owner in TokensAPI takes up to a minute. Entries are keyed by the
// Key's fingerprint, never its value; a failure is not kept, and a new provider starts afresh.
const IDENTITY_TTL = 60_000
const identities = new WeakMap()
export async function resolveIdentity(apiKey, env) {
  let cache = identities.get(env)
  if (!cache || cache.source !== env.MARKET_ORGANIZATIONS) {
    cache = { source: env.MARKET_ORGANIZATIONS, entries: new Map() }
    identities.set(env, cache)
  }
  const id = await fingerprint(apiKey, env.MARKET_HMAC_SECRET)
  const previous = cache.entries.get(id)
  if (previous && (previous.pending || previous.expires > Date.now())) return previous.promise
  if (cache.entries.size >= 4096) {
    for (const [key, entry] of cache.entries) {
      if (!entry.pending) cache.entries.delete(key)
      if (cache.entries.size < 4096) break
    }
  }
  const entry = { pending: true, expires: 0 }
  entry.promise = lookupIdentity(apiKey, env).then(value => {
    entry.pending = false
    entry.expires = Date.now() + IDENTITY_TTL
    return value
  }, error => { cache.entries.delete(id); throw error })
  cache.entries.set(id, entry)
  return entry.promise
}
// One upstream call names the Key's organization and its owner. A provider that only knows
// organizations answers with no user, so user grants simply never match.
async function lookupIdentity(apiKey, env) {
  const source = provider(env)
  if (typeof source?.resolveIdentity !== 'function') return { organization: await resolveOrganization(apiKey, env), user: null }
  const identity = await bounded(() => source.resolveIdentity(apiKey))
  if (!identity || (identity.organization !== null && !validOrganization(identity.organization))
    || (identity.user != null && !validUser(identity.user))) throw new Error('invalid identity response')
  return {
    organization: identity.organization && { id: identity.organization.id, name: identity.organization.name },
    user: identity.user ? { id: identity.user.id, name: identity.user.name } : null,
  }
}
export function userSearchReady(env) {
  return typeof provider(env)?.searchUsers === 'function'
}
async function lookupUsers(env, keyword, page, size) {
  if (!userSearchReady(env)) throw Object.assign(new Error('未配置 TokensAPI 用户搜索'), { status: 503 })
  let result
  try { result = await bounded(() => provider(env).searchUsers(keyword, page, size)) }
  catch { throw Object.assign(new Error('TokensAPI 用户搜索暂不可用'), { status: 503 }) }
  if (!result || !Array.isArray(result.items) || !result.items.every(validUser)) throw Object.assign(new Error('TokensAPI 用户搜索返回无效'), { status: 503 })
  return result
}
const listed = user => ({ id: user.id, name: user.name, username: user.username ?? '' })
export async function searchUsers(env, keyword, page) {
  const result = await lookupUsers(env, keyword, page, 20)
  return { items: result.items.map(listed), total: result.total ?? result.items.length }
}
// The same site-wide search, answered for one organization: TokensAPI names each match's
// organization and only that organization's own members are returned, so an organization
// administrator never sees anyone else. One page of 100 is read; `more` asks for a sharper keyword.
export async function searchOrganizationMembers(env, organizationId, keyword) {
  const result = await lookupUsers(env, keyword, 1, 100)
  return {
    items: result.items.filter(user => user.organizationId === organizationId).map(listed),
    more: (result.total ?? 0) > result.items.length,
  }
}
// Whether one user belongs to the organization, asked by user number (TokensAPI matches a numeric
// keyword against the id exactly). Null when TokensAPI does not place the user there.
export async function organizationMember(env, organizationId, userId) {
  const result = await lookupUsers(env, String(userId), 1, 100)
  const user = result.items.find(item => item.id === userId && item.organizationId === organizationId)
  return user ? { id: user.id, name: user.name } : null
}

// The two console-login lookups. The forwarded site cookie lives only for the duration of these
// calls: nothing here stores, caches or logs it, and a provider outage throws rather than
// resolving, so a failure can never be mistaken for a successful sign-in.
export async function resolveSiteAccount(session, env) {
  if (!organizationSessionReady(env)) throw new Error('organization provider unavailable')
  const account = await bounded(() => provider(env).resolveAccount(session))
  if (account === null) return null
  if (!validOrganizationId(account.id) || typeof account.displayName !== 'string' || !account.displayName.trim()) throw new Error('invalid account response')
  return { id: account.id, displayName: account.displayName }
}
export async function resolveSiteOrganization(session, env) {
  if (!organizationSessionReady(env)) throw new Error('organization provider unavailable')
  const org = await bounded(() => provider(env).resolveMyOrg(session))
  if (org === null) return null
  if (!validOrganization(org) || !Number.isSafeInteger(org.role)) throw new Error('invalid organization response')
  return { id: org.id, name: org.name, role: org.role }
}

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }

export async function listOrganizations(env) {
  const { results } = await env.MARKET_DB.prepare(`SELECT o.id,o.name,o.enabled,
    (SELECT COUNT(*) FROM market_grants g WHERE g.kind='org' AND g.subject=CAST(o.id AS TEXT)) AS granted,
    (SELECT COUNT(*) FROM market_org_hidden h WHERE h.organization_id=o.id) AS hidden
    FROM market_organizations o ORDER BY o.name,o.id`).all()
  return { items: results.map(row => ({ ...row, enabled: row.enabled === 1 })), syncReady: organizationListReady(env) }
}
export async function getOrganization(env, id) {
  const row = await env.MARKET_DB.prepare('SELECT id,name,enabled FROM market_organizations WHERE id=?').bind(id).first()
  if (!row) fail('组织不存在', 404)
  return { ...row, enabled: row.enabled === 1 }
}
// Registering an organization by hand, renaming it, or switching it off for the whole market.
export async function saveOrganization(env, id, data, actor) {
  if (!validOrganizationId(id) || !(typeof data?.name === 'string' && data.name.trim() && data.name.length <= 200)
    || typeof data?.enabled !== 'boolean') fail('请填写有效的组织名称和启用状态')
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare(`INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled`).bind(id, data.name.trim(), Number(data.enabled)),
    ...auditStatements(env, 'organization.updated', id, { enabled: data.enabled }, actor),
  ])
  return { ok: true }
}
