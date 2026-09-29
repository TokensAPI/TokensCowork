import { bearer } from '../http/request.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { resolveIdentity, validOrganizationId, organizationMember } from './organizations.js'
import { catalogRoster, productComponents, invalid } from './plugins.js'
import { auditStatements } from './audit.js'

const NO_ORGANIZATION = Object.freeze({ id: 0, grants: new Set(), hidden: new Set(), members: new Map() })
const MAX_MEMBERS = 200
const ids = (results, column = 'plugin_id') => new Set(results.map(row => row[column]))
const builtinIdentities = components => ({
  ids: new Set(components.items.map(item => item.id)),
  packages: new Set(components.items.map(item => item.package).filter(Boolean)),
})
const isBuiltin = (item, builtin) => builtin.ids.has(item.id) || builtin.packages.has(item.package)

async function keyGrants(env, key) {
  if (!key) return new Set()
  const fp = await fingerprint(key, env.MARKET_HMAC_SECRET)
  const { results } = await env.MARKET_DB.prepare("SELECT plugin_id FROM market_grants WHERE kind='key' AND subject=?").bind(fp).all()
  return ids(results)
}
async function userGrants(env, user) {
  if (!user) return new Set()
  const { results } = await env.MARKET_DB.prepare("SELECT plugin_id FROM market_grants WHERE kind='user' AND subject=?").bind(String(user.id)).all()
  return ids(results)
}

// What the platform offers one organization, what that organization switched off again, and the
// plugins it narrowed to named members (plugin -> user id -> name). A disabled organization is
// offered nothing.
async function organizationState(env, organizationId) {
  const [{ results: grants }, { results: hidden }, { results: named }] = await Promise.all([
    env.MARKET_DB.prepare(`SELECT g.plugin_id FROM market_grants g JOIN market_organizations o ON g.subject=CAST(o.id AS TEXT)
      WHERE g.kind='org' AND o.id=? AND o.enabled=1`).bind(organizationId).all(),
    env.MARKET_DB.prepare('SELECT plugin_id FROM market_org_hidden WHERE organization_id=?').bind(organizationId).all(),
    env.MARKET_DB.prepare('SELECT plugin_id,user_id,name FROM market_org_members WHERE organization_id=? ORDER BY name,user_id').bind(organizationId).all(),
  ])
  const members = new Map()
  for (const row of named) {
    if (!members.has(row.plugin_id)) members.set(row.plugin_id, new Map())
    members.get(row.plugin_id).set(row.user_id, row.name)
  }
  return { id: organizationId, grants: ids(grants), hidden: ids(hidden), members }
}
const memberList = (state, pluginId) => [...(state.members.get(pluginId) ?? new Map())].map(([id, name]) => ({ id, name }))

// Everything the answer depends on except who owns the caller's Key -- its organization and its
// user -- which costs an upstream call and is therefore resolved only when it can change an answer.
async function baseline(request, env, restricted) {
  const { results } = await env.MARKET_DB.prepare("SELECT DISTINCT plugin_id FROM market_grants WHERE kind IN ('org','user')").all()
  return { keys: restricted ? await keyGrants(env, bearer(request)) : new Set(), offered: ids(results), organization: NO_ORGANIZATION, users: new Set(), user: null }
}
async function callerIdentity(request, env, state) {
  const key = bearer(request)
  if (!key) return
  const identity = await resolveIdentity(key, env)
  const [organization, users] = await Promise.all([
    identity.organization ? organizationState(env, identity.organization.id) : NO_ORGANIZATION, userGrants(env, identity.user),
  ])
  Object.assign(state, { organization, users, user: identity.user?.id ?? null })
}
// Only a restricted plugin the caller holds no Key grant for, offered to some organization or user.
const needsIdentity = (plugin, state) =>
  plugin.visibility !== 'public' && !state.keys.has(plugin.id) && state.offered.has(plugin.id)

// An organization grant reaches every member unless the organization named members for it.
function member(pluginId, state) {
  const named = state.organization.members.get(pluginId)
  return !named || named.has(state.user)
}
// The single authorization decision, shared by the catalog, the Registry proxy and the console
// so they can never disagree. Four independent sources, OR-ed; the organization switch and its
// member list live inside the organization term alone and can only narrow what the platform offered.
// Built-in components are governed by the application and never reach here.
function decide(plugin, state) {
  return plugin.visibility === 'public'
    || state.keys.has(plugin.id)
    || state.users.has(plugin.id)
    || (state.organization.grants.has(plugin.id) && !state.organization.hidden.has(plugin.id) && member(plugin.id, state))
}

export async function allowed(request, env, pluginId) {
  const plugin = await env.MARKET_DB.prepare("SELECT id,visibility,metadata FROM market_plugins WHERE id=? AND state='published'").bind(pluginId).first()
  if (!plugin) return false
  const builtin = builtinIdentities(await productComponents(request, env))
  let metadata
  try { metadata = JSON.parse(plugin.metadata) } catch { return false }
  if (isBuiltin({ id: plugin.id, package: metadata.package }, builtin)) return false
  const state = await baseline(request, env, plugin.visibility !== 'public')
  if (needsIdentity(plugin, state)) await callerIdentity(request, env, state)
  return decide(plugin, state)
}

export async function filterRoster(request, env, roster) {
  if (!env.MARKET_DB) return roster
  const builtin = builtinIdentities(await productComponents(request, env))
  const { results } = await env.MARKET_DB.prepare("SELECT id,visibility,metadata FROM market_plugins WHERE state='published'").all()
  const merged = new Map(roster.items.filter(item => !isBuiltin(item, builtin)).map(item => [item.id, item]))
  // A component promoted into the application cannot inherit stale market restrictions.
  const governed = results.filter(row => merged.has(row.id) && merged.get(row.id)?.category !== 'builtin')
  const state = await baseline(request, env, governed.some(row => row.visibility !== 'public'))
  if (governed.some(row => needsIdentity(row, state))) {
    try { await callerIdentity(request, env, state) }
    catch (error) { if (!state.keys.size) throw error } // Key grants remain usable on their own.
  }
  for (const row of governed) {
    const releaseItem = merged.get(row.id)
    if (!releaseItem || releaseItem.category === 'builtin') continue
    merged.delete(row.id)
    // Release updates own package metadata; the database owns only access policy.
    if (decide(row, state)) merged.set(row.id, { ...JSON.parse(row.metadata), ...releaseItem })
  }
  return { ...roster, items: [...merged.values()] }
}

// One organization's view: every published plugin its members can be offered, why, the switch
// its administrator holds and the members it is narrowed to. `visible` answers whether the
// organization receives the plugin at all, so the member list is left out of that decide().
export async function organizationPlugins(request, env, organizationId) {
  const [roster, components, state] = await Promise.all([
    catalogRoster(env), productComponents(request, env), organizationState(env, organizationId),
  ])
  const builtin = new Set(components.items.map(item => item.id))
  const view = { keys: new Set(), offered: new Set(), organization: { ...state, members: new Map() }, users: new Set(), user: null }
  return {
    organizationId,
    items: roster.items
      .filter(item => !builtin.has(item.id) && (item.visibility === 'public' || state.grants.has(item.id)))
      .map(item => ({
        id: item.id, displayName: item.displayName, package: item.package, summary: item.summary, version: item.version,
        source: item.visibility === 'public' ? 'public' : 'organization',
        // Only an organization grant can be switched; a public plugin reaches everyone regardless.
        switchable: item.visibility !== 'public',
        enabled: !state.hidden.has(item.id),
        members: memberList(state, item.id),
        visible: decide(item, view),
      })),
  }
}

// The organization administrator's two narrowing tools for one granted plugin: the switch, and
// the member list (empty = every member). Either or both may be sent; a newly listed user must be
// a member of the organization according to TokensAPI.
export async function setOrganizationPlugin(request, env, organizationId, pluginId, data, actor) {
  if (!validOrganizationId(organizationId)) throw invalid('组织无效')
  const hasEnabled = data?.enabled !== undefined, hasMembers = data?.members !== undefined
  if (!hasEnabled && !hasMembers) throw invalid('请提供 enabled 开关或 members 成员列表')
  if (hasEnabled && typeof data.enabled !== 'boolean') throw invalid('enabled 必须是布尔值')
  if (hasMembers && (!Array.isArray(data.members) || data.members.length > MAX_MEMBERS || !data.members.every(validOrganizationId)
    || new Set(data.members).size !== data.members.length)) throw invalid(`members 必须是不重复的用户 ID 列表，最多 ${MAX_MEMBERS} 个`)
  if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_organizations WHERE id=?').bind(organizationId).first()) throw invalid('组织不存在', 404)
  const plugin = await env.MARKET_DB.prepare("SELECT visibility FROM market_plugins WHERE id=? AND state='published'").bind(pluginId).first()
  if (!plugin) throw invalid('插件不存在或尚未上架', 404)
  const components = await productComponents(request, env)
  if (components.items.some(item => item.id === pluginId)) throw invalid('内置组件不受组织开关约束', 409)
  if (plugin.visibility === 'public') throw invalid('公开插件对所有人可见，不受组织开关约束')
  if (!await env.MARKET_DB.prepare("SELECT 1 FROM market_grants WHERE plugin_id=? AND kind='org' AND subject=?").bind(pluginId, String(organizationId)).first())
    throw invalid('该插件未授予此组织')
  const statements = []
  if (hasEnabled) statements.push(data.enabled
    ? env.MARKET_DB.prepare('DELETE FROM market_org_hidden WHERE organization_id=? AND plugin_id=?').bind(organizationId, pluginId)
    : env.MARKET_DB.prepare('INSERT INTO market_org_hidden(organization_id,plugin_id) VALUES(?,?) ON CONFLICT DO NOTHING').bind(organizationId, pluginId))
  if (hasMembers) {
    const { results } = await env.MARKET_DB.prepare('SELECT user_id,name FROM market_org_members WHERE organization_id=? AND plugin_id=?').bind(organizationId, pluginId).all()
    const kept = new Map(results.map(row => [row.user_id, row.name]))
    const members = []
    for (const id of data.members) {
      if (kept.has(id)) { members.push({ id, name: kept.get(id) }); continue }
      const user = await organizationMember(env, organizationId, id)
      if (!user) throw invalid(`用户 #${id} 不是本组织成员`)
      members.push(user)
    }
    statements.push(env.MARKET_DB.prepare('DELETE FROM market_org_members WHERE organization_id=? AND plugin_id=?').bind(organizationId, pluginId),
      ...members.map(user => env.MARKET_DB.prepare('INSERT INTO market_org_members(organization_id,plugin_id,user_id,name) VALUES(?,?,?,?)')
        .bind(organizationId, pluginId, user.id, user.name)))
  }
  const details = { ...(hasEnabled ? { enabled: data.enabled } : {}), ...(hasMembers ? { memberCount: data.members.length } : {}) }
  await env.MARKET_DB.batch([...statements, ...auditStatements(env, 'tenant.plugin.updated', `${organizationId}:${pluginId}`, details, actor)])
  const state = await organizationState(env, organizationId)
  return { ok: true, enabled: !state.hidden.has(pluginId), members: memberList(state, pluginId) }
}
