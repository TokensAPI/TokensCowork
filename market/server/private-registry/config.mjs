/** Optional server-side private npm Registry configuration. */
export function registryConfig(env = {}) {
  if (env.MARKET_PRIVATE_REGISTRY_ENABLED !== 'true') return { enabled: false, ready: false }
  if (!env.MARKET_PRIVATE_REGISTRY_URL || !env.MARKET_PRIVATE_REGISTRY_TOKEN)
    return { enabled: true, ready: false, reason: 'missing-configuration' }
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
      token: env.MARKET_PRIVATE_REGISTRY_TOKEN,
      timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000 ? timeoutMs : 8000,
    }
  } catch { return { enabled: true, ready: false, reason: 'invalid-url' } }
}
