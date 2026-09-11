function safeDetails(action, details) {
  if (/^catalog\.(created|edit|publish|archive|trash|restore|purge)$/u.test(action)) return { state: details.state }
  // Explicit allowlists prevent later call sites from accidentally auditing credentials.
  if (action === 'plugin.access.updated') return {
    visibility: details.visibility === 'restricted' ? 'restricted' : 'public',
    organizationCount: details.organizationCount,
    keyCount: details.keyCount,
  }
  if (action === 'organization.updated') return { enabled: details.enabled === true }
  if (action === 'organizations.synced') return { count: details.count }
  throw new Error('Unsupported audit action')
}

export function auditStatements(env, action, target, details) {
  const source = env.MARKET_ORGANIZATIONS_BASE_URL === 'https://tokensapi.ai' ? 'production'
    : env.MARKET_ORGANIZATIONS_BASE_URL === 'https://dev.tokensapi.ai' ? 'development' : 'unconfigured'
  const safeTarget = action === 'organizations.synced' ? source : String(target)
  if (action.startsWith('catalog.') && !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(safeTarget)) throw new Error('Invalid catalog audit target')
  if (action === 'organization.updated' && !/^[1-9][0-9]*$/u.test(safeTarget)) throw new Error('Invalid audit target')
  if (action === 'plugin.access.updated' && !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(safeTarget)) throw new Error('Invalid audit target')
  return [
    env.MARKET_DB.prepare('INSERT INTO market_admin_audit(action,target,details,created_at) VALUES(?,?,?,?)')
      .bind(action, safeTarget, JSON.stringify(safeDetails(action, details)), Date.now()),
    // Keep a bounded operational history. This is not a compliance audit ledger.
    env.MARKET_DB.prepare('DELETE FROM market_admin_audit WHERE id NOT IN (SELECT id FROM market_admin_audit ORDER BY id DESC LIMIT 1000)'),
  ]
}
