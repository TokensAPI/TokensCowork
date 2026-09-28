import { registryConfig } from '../private-registry/config.mjs'

const PLUGIN = /^[a-z0-9][a-z0-9-]{0,79}$/u
const ORGANIZATION = /^[1-9][0-9]*$/u
const FINGERPRINT = /^[a-f0-9]{64}$/u
// Every action the market records, the target it names, and the only details it may keep.
// Explicit allowlists prevent a later call site from accidentally auditing a credential.
const ACTIONS = {
  'catalog.created': [PLUGIN, d => ({ state: d.state })],
  'catalog.edit': [PLUGIN, d => ({ state: d.state })],
  'catalog.publish': [PLUGIN, d => ({ state: d.state })],
  'catalog.archive': [PLUGIN, d => ({ state: d.state })],
  'catalog.trash': [PLUGIN, d => ({ state: d.state })],
  'catalog.restore': [PLUGIN, d => ({ state: d.state })],
  'catalog.purge': [PLUGIN, d => ({ state: d.state })],
  'plugin.access.updated': [PLUGIN, d => ({ visibility: d.visibility === 'restricted' ? 'restricted' : 'public',
    organizationCount: d.organizationCount, keyCount: d.keyCount, userCount: d.userCount })],
  // One organization's, Key's or user's whole grant list replaced from the subject's side.
  'grants.updated': [/^(?:org:[1-9][0-9]*|key:[a-f0-9]{64}|user:[1-9][0-9]*)$/u,
    d => ({ pluginCount: d.pluginCount, added: d.added, removed: d.removed })],
  'organization.updated': [ORGANIZATION, d => ({ enabled: d.enabled === true })],
  'organizations.synced': [/^(production|development|unconfigured)$/u, d => ({ count: d.count })],
  // Organization switches are addressed by organization and plugin together; keep the pair greppable.
  'tenant.plugin.updated': [/^[1-9][0-9]*:[a-z0-9][a-z0-9-]{0,79}$/u, d => ({ enabled: d.enabled === true })],
  'key.added': [FINGERPRINT, () => ({})],
  'key.updated': [FINGERPRINT, () => ({})],
  'key.deleted': [FINGERPRINT, d => ({ grantCount: d.grantCount })],
  'user.updated': [ORGANIZATION, () => ({})],
  'user.deleted': [ORGANIZATION, d => ({ grantCount: d.grantCount })],
}
// The platform administrator is the default for call sites with no principal to hand.
export const ROOT_ACTOR = Object.freeze({ kind: 'root', id: 'token', organizationId: null })
function safeActor(actor) {
  const kind = ['root', 'tenant'].includes(actor?.kind) ? actor.kind : 'root'
  const id = typeof actor?.id === 'string' && /^[A-Za-z0-9_.:-]{0,128}$/u.test(actor.id) ? actor.id : ''
  const organizationId = Number.isSafeInteger(actor?.organizationId) && actor.organizationId > 0 ? actor.organizationId : null
  return { kind, id, organizationId }
}
export function organizationEnvironment(env) {
  const origin = env.MARKET_ORGANIZATIONS_BASE_URL
  if (origin === 'https://tokensapi.ai') return { origin, name: 'production' }
  if (origin === 'https://dev.tokensapi.ai') return { origin, name: 'development' }
  return { origin: null, name: 'unconfigured' }
}
export function auditStatements(env, action, target, details, actor = ROOT_ACTOR) {
  const rule = ACTIONS[action]
  if (!rule) throw new Error('Unsupported audit action')
  const safeTarget = action === 'organizations.synced' ? organizationEnvironment(env).name : String(target)
  if (!rule[0].test(safeTarget)) throw new Error('Invalid audit target')
  const who = safeActor(actor)
  return [
    env.MARKET_DB.prepare('INSERT INTO market_audit_events(actor_kind,actor_id,organization_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(who.kind, who.id, who.organizationId, action, safeTarget, JSON.stringify(rule[1](details)), Date.now()),
    // Keep a bounded operational history. This is not a compliance audit ledger.
    env.MARKET_DB.prepare('DELETE FROM market_audit_events WHERE id NOT IN (SELECT id FROM market_audit_events ORDER BY id DESC LIMIT 5000)'),
  ]
}

export async function auditLog(env, limit = 100) {
  const { results } = await env.MARKET_DB.prepare(
    'SELECT id,actor_kind,actor_id,organization_id,action,target,details,created_at FROM market_audit_events ORDER BY id DESC LIMIT ?',
  ).bind(limit).all()
  return {
    items: results.map(row => ({
      id: row.id, action: row.action, target: row.target,
      actor: { kind: row.actor_kind, id: row.actor_id, organizationId: row.organization_id },
      details: JSON.parse(row.details), createdAt: row.created_at,
    })),
  }
}

// What this instance is connected to, for the console header. Booleans only, never a secret.
export function environment(env, organizationReady) {
  return {
    ...organizationEnvironment(env),
    ...(env.MARKET_PREVIEW_MODE ? { preview: true } : {}),
    organizationReady,
    keyDisplayReady: Boolean(env.MARKET_KEY_ENCRYPTION_SECRET),
    privateRegistryReady: registryConfig(env).ready === true,
  }
}
