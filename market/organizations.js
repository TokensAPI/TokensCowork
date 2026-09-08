// Internal adapter contract, not a TokensAPI HTTP contract. No test identities in production.
// Replace this adapter's provider calls when the real TokensAPI documentation arrives.
export const validOrganizationId = value => Number.isSafeInteger(value) && value > 0
export function organizationProviderReady(env) {
  return typeof env.MARKET_ORGANIZATIONS?.resolveOrganization === 'function'
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
export async function syncOrganizations(env) {
  if(typeof env.MARKET_ORGANIZATIONS?.listOrganizations!=='function') throw new Error('organization listing unavailable')
  const organizations=await bounded(()=>env.MARKET_ORGANIZATIONS.listOrganizations())
  if(!Array.isArray(organizations) || organizations.length>10000 || !organizations.every(validOrganization)
    || new Set(organizations.map(o=>o.id)).size!==organizations.length) throw new Error('invalid organization list')
  // Do not reactivate locally disabled organizations or delete grants absent from one sync.
  if(organizations.length) await env.MARKET_DB.batch(organizations.map(org=>env.MARKET_DB.prepare(`INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name`).bind(org.id,org.name.trim())))
  return organizations.length
}
export async function resolveOrganization(apiKey, env) {
  if (!organizationProviderReady(env)) throw new Error('organization provider unavailable')
  const organization = await bounded(()=>env.MARKET_ORGANIZATIONS.resolveOrganization(apiKey))
  if (organization === null) return null // Invalid/revoked Key or no organization.
  if (!validOrganization(organization)) throw new Error('invalid organization response')
  return { id: organization.id, name: organization.name }
}

export async function organizationAccess(request, env) {
  const key = /^Bearer ([^\s]{1,512})$/u.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!key) return new Set()
  const org = await resolveOrganization(key, env)
  if (!org) return new Set()
  const { results } = await env.MARKET_DB.prepare(`SELECT g.plugin_id FROM market_org_grants g
    JOIN market_organizations o ON o.id=g.organization_id WHERE o.id=? AND o.enabled=1`).bind(org.id).all()
  return new Set(results.map(row => row.plugin_id))
}

export async function organizationState(env) {
  const [organizations, policies, grants] = await Promise.all([
    env.MARKET_DB.prepare('SELECT id,name,enabled FROM market_organizations ORDER BY name,id').all(),
    env.MARKET_DB.prepare('SELECT plugin_id FROM market_org_policies').all(),
    env.MARKET_DB.prepare('SELECT plugin_id,organization_id FROM market_org_grants').all(),
  ])
  return { organizations: organizations.results, organizationPolicies: policies.results,
    organizationGrants: grants.results, organizationProviderReady: organizationProviderReady(env),
    organizationListReady: typeof env.MARKET_ORGANIZATIONS?.listOrganizations==='function' }
}
