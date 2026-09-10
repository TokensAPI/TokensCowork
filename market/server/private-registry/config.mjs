/** Optional server-side private npm Registry configuration. */

/**
 * Verdaccio issues JWTs that expire (60 days by default), so a Bearer token is
 * not a durable machine credential. `basic` lets the Worker hold the read-only
 * service account itself: it never expires and is revoked by changing the
 * password. Verdaccio accepts Basic auth in both AES and JWT modes.
 */
function authorization(scheme, token) {
  if (scheme === 'bearer') return 'Bearer ' + token
  const separator = token.indexOf(':')
  if (separator <= 0 || separator === token.length - 1) return undefined
  // btoa is latin1-only; a credential outside that range cannot be encoded.
  if (!/^[\x21-\x7e]+:[\x20-\x7e]+$/u.test(token)) return undefined
  return 'Basic ' + btoa(token)
}

export function registryConfig(env = {}) {
  if (env.MARKET_PRIVATE_REGISTRY_ENABLED !== 'true') return { enabled: false, ready: false }
  if (!env.MARKET_PRIVATE_REGISTRY_URL || !env.MARKET_PRIVATE_REGISTRY_TOKEN)
    return { enabled: true, ready: false, reason: 'missing-configuration' }
  const scheme = (env.MARKET_PRIVATE_REGISTRY_AUTH_SCHEME ?? 'bearer').toLowerCase()
  if (scheme !== 'bearer' && scheme !== 'basic') return { enabled: true, ready: false, reason: 'invalid-auth-scheme' }
  const header = authorization(scheme, env.MARKET_PRIVATE_REGISTRY_TOKEN)
  if (!header) return { enabled: true, ready: false, reason: 'invalid-credentials' }
  try {
    const url = new URL(env.MARKET_PRIVATE_REGISTRY_URL)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return { enabled: true, ready: false, reason: 'invalid-url' }
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    const timeoutMs = Number(env.MARKET_PRIVATE_REGISTRY_TIMEOUT_MS ?? 8000)
    return {
      enabled: true,
      ready: true,
      url: url.toString(),
      authorization: header,
      timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000 ? timeoutMs : 8000,
    }
  } catch { return { enabled: true, ready: false, reason: 'invalid-url' } }
}
