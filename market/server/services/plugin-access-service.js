import { bearer } from '../http/request.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { organizationAccess } from './organization-service.js'
export async function allowed(request, env, pluginId) {
  if (await env.MARKET_DB.prepare('SELECT 1 FROM market_org_policies WHERE plugin_id=?').bind(pluginId).first()) {
    if ((await directKeyAccess(request,env)).has(pluginId)) return true
    if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_org_grants WHERE plugin_id=?').bind(pluginId).first()) return false
    return (await organizationAccess(request, env)).has(pluginId)
  }
  const key = bearer(request)
  if (!key || !env.MARKET_HMAC_SECRET) return false
  const fp = await fingerprint(key, env.MARKET_HMAC_SECRET)
  return !!await env.MARKET_DB.prepare(`SELECT 1 FROM market_keys k JOIN market_grants g ON g.fingerprint=k.fingerprint
    WHERE k.fingerprint=? AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>?) AND g.plugin_id=?`)
    .bind(fp, Date.now(), pluginId).first()
}
async function directKeyAccess(request,env) {
  const key=bearer(request)
  if(!key) return new Set()
  const fp=await fingerprint(key,env.MARKET_HMAC_SECRET)
  const {results}=await env.MARKET_DB.prepare('SELECT plugin_id FROM market_plugin_key_grants WHERE fingerprint=?').bind(fp).all()
  return new Set(results.map(row=>row.plugin_id))
}
export async function filterRoster(request, env, roster) {
  if (!env.MARKET_DB) return roster
  const { results } = await env.MARKET_DB.prepare("SELECT p.* FROM market_plugins p JOIN market_catalog c ON c.id=p.id WHERE c.state='published'").all()
  const merged = new Map(roster.items.map(item => [item.id, item]))
  const { results: policies } = await env.MARKET_DB.prepare('SELECT plugin_id FROM market_org_policies').all()
  const orgPolicies = new Set(policies.map(p => p.plugin_id))
  const directAllowed=await directKeyAccess(request,env)
  const {results: orgGrants}=await env.MARKET_DB.prepare('SELECT DISTINCT plugin_id FROM market_org_grants').all()
  const orgIds=new Set(orgGrants.map(g=>g.plugin_id))
  const needsOrg = results.some(row => row.visibility !== 'public' && merged.get(row.id)?.category !== 'builtin' && orgIds.has(row.id) && !directAllowed.has(row.id))
  let orgAllowed=new Set()
  if(needsOrg) {
    try {orgAllowed=await organizationAccess(request,env)}
    catch(error) {if(!directAllowed.size) throw error} // Explicit Key grants remain usable independently.
  }
  for (const row of results) {
    const releaseItem = merged.get(row.id)
    // A component promoted into the application cannot inherit stale market restrictions.
    if (!releaseItem || releaseItem.category === 'builtin') continue
    merged.delete(row.id)
    const privateRegistry = JSON.parse(row.metadata).registry === 'tokenscowork'
    if ((!privateRegistry && row.visibility === 'public') || (orgPolicies.has(row.id) ? directAllowed.has(row.id) || orgAllowed.has(row.id) : await allowed(request, env, row.id))) {
      // Release updates own package metadata; the database owns only access policy.
      merged.set(row.id, { ...JSON.parse(row.metadata), ...releaseItem })
    }
  }
  return { ...roster, items: [...merged.values()] }
}
