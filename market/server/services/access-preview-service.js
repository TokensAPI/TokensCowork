import { fingerprint } from '../security/key-fingerprint.js'
import { filterRoster } from './plugin-access-service.js'
import { resolveOrganization } from './organization-service.js'

/** Read-only administrator diagnosis; never persist or return the submitted Key. */
export async function accessPreview(request, env, apiKey) {
  const rosterResponse = await env.ASSETS.fetch(new URL('/roster.json', request.url).toString())
  if (!rosterResponse.ok) throw new Error('Roster unavailable')
  const roster = await rosterResponse.json()
  if (!Array.isArray(roster.items)) throw new Error('Invalid roster')

  // The same provider result is shared by the summary and the real catalog policy path.
  let identityPromise
  const identity = () => identityPromise ??= resolveOrganization(apiKey, env)
  let organization = null, organizationStatus = 'none', warning = null
  try {
    const resolved = await identity()
    if (resolved) {
      const local = await env.MARKET_DB.prepare('SELECT enabled FROM market_organizations WHERE id=?').bind(resolved.id).first()
      organization = { ...resolved, registered: Boolean(local), enabled: local?.enabled === 1 }
      organizationStatus = 'matched'
      if (!local) warning = '已识别组织，但尚未同步到组织名录；当前只能命中公开或单独 Key 授权。'
      else if (!local.enabled) warning = '该组织已在市场停用；单独 Key 授权仍按独立规则判断。'
    } else {
      warning = '未返回可用组织：可能是私人 Key、无效 Key 或已停用身份。单独 Key 授权独立判断。'
    }
  } catch {
    organizationStatus = 'unavailable'
    warning = '组织身份暂时无法识别；不会放行组织专属权限。'
  }
  const visitor = new Request(new URL('/roster.json', request.url), { headers: { Authorization: 'Bearer ' + apiKey } })
  let visible = new Set(), catalogAvailable = true
  try {
    const filtered = await filterRoster(visitor, { ...env, MARKET_ORGANIZATIONS: { resolveOrganization: identity } }, roster)
    visible = new Set(filtered.items.map(item => item.id))
  } catch (error) {
    if (organizationStatus !== 'unavailable') throw error
    catalogAvailable = false
    warning = '组织服务不可用，客户端目录当前会返回暂不可用；未放行任何组织专属权限。'
  }
  const [{ results: policies }, { results: direct }, { results: legacy }, { results: plugins }] = await Promise.all([
    env.MARKET_DB.prepare('SELECT plugin_id FROM market_org_policies').all(),
    env.MARKET_DB.prepare('SELECT plugin_id FROM market_plugin_key_grants WHERE fingerprint=?').bind(await fingerprint(apiKey, env.MARKET_HMAC_SECRET)).all(),
    env.MARKET_DB.prepare(`SELECT g.plugin_id FROM market_grants g JOIN market_keys k ON g.fingerprint=k.fingerprint
      WHERE k.fingerprint=? AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>?)`)
      .bind(await fingerprint(apiKey, env.MARKET_HMAC_SECRET), Date.now()).all(),
    env.MARKET_DB.prepare('SELECT id,visibility,metadata FROM market_plugins').all(),
  ])
  const migrated = new Set(policies.map(row => row.plugin_id))
  const directIds = new Set(direct.map(row => row.plugin_id))
  const legacyIds = new Set(legacy.map(row => row.plugin_id))
  const saved = new Map(plugins.map(row => [row.id, row]))
  const items = new Map(roster.items.map(item => [item.id, item]))
  for (const plugin of plugins) if (!items.has(plugin.id)) items.set(plugin.id, JSON.parse(plugin.metadata))
  const decisions = [...items.values()].map(item => {
    const allowed = visible.has(item.id)
    const isPublic = item.category === 'builtin' || !saved.has(item.id) || saved.get(item.id).visibility === 'public'
    const isDirect = migrated.has(item.id) ? directIds.has(item.id) : legacyIds.has(item.id)
    return {
      id: item.id, displayName: item.displayName, package: item.package, category: item.category ?? 'optional',
      allowed, reason: !allowed ? 'denied' : isPublic ? 'public' : isDirect ? 'direct' : 'organization',
    }
  })
  const allowedCount = decisions.filter(item => item.allowed).length
  return {
    organization, organizationStatus, catalogAvailable, warning, items: decisions,
    summary: { total: decisions.length, allowed: allowedCount, denied: decisions.length - allowedCount },
  }
}
