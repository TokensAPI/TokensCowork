import { organizationProviderReady, organizationListReady } from './organization-service.js'
import { registryConfig } from '../private-registry/config.mjs'

export function organizationEnvironment(env) {
  const origin = env.MARKET_ORGANIZATIONS_BASE_URL
  if (origin === 'https://tokensapi.ai') return { origin, name: 'production' }
  if (origin === 'https://dev.tokensapi.ai') return { origin, name: 'development' }
  return { origin: null, name: 'unconfigured' }
}

export async function adminOperations(env) {
  const privateRegistry = registryConfig(env)
  const { results } = await env.MARKET_DB.prepare(
    'SELECT id,action,target,details,created_at FROM market_admin_audit ORDER BY id DESC LIMIT 50',
  ).all()
  return {
    environment: {
      ...organizationEnvironment(env),
      organizationReady: organizationProviderReady(env),
      organizationListReady: organizationListReady(env),
      keyDisplayReady: Boolean(env.MARKET_KEY_ENCRYPTION_SECRET),
      privatePackagesReady: Boolean(env.MARKET_PACKAGES),
      privateRegistryReady: privateRegistry.ready === true,
    },
    recentActions: results.map(row => ({
      id: row.id, action: row.action, target: row.target,
      details: JSON.parse(row.details), createdAt: row.created_at,
    })),
  }
}
