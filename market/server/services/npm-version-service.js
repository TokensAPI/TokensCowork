import { latestVersion } from '../integrations/npm-registry.js'
import { createRegistryClient } from '../private-registry/client.mjs'

// Cache version hints only, never customer authorization or download responses.
// Environment identity isolates deployments; credential changes invalidate hints.
const caches = new WeakMap()
export function invalidateVersionHints(env) { caches.delete(env) }
async function versionHint(env, registry, name) {
  const identity = [env.MARKET_PRIVATE_REGISTRY_URL, env.MARKET_PRIVATE_REGISTRY_TOKEN,
    env.MARKET_PRIVATE_REGISTRY_AUTH_SCHEME, env.MARKET_PRIVATE_REGISTRY_ENABLED]
  let cache = caches.get(env)
  if (!cache || identity.some((value, i) => value !== cache.identity[i])) {
    cache = { identity, entries: new Map() }
    caches.set(env, cache)
  }
  const key = `${registry}:${name}`
  const previous = cache.entries.get(key)
  if (previous && (previous.pending || previous.expires > Date.now())) return previous.promise
  // Bounded process-local cache; no persistence of registry credentials.
  if (cache.entries.size >= 512) {
    for (const [key, entry] of cache.entries) {
      if (!entry.pending) cache.entries.delete(key)
      if (cache.entries.size < 512) break
    }
  }
  const entry = { pending: true, expires: 0 }
  entry.promise = Promise.resolve().then(() => registry === 'tokenscowork'
    ? createRegistryClient(env).latestVersion(name) : latestVersion(name, ''))
    .then(value => {
      entry.pending = false
      entry.expires = value ? Date.now() + 30_000 : 0
      if (!value) cache.entries.delete(key)
      return value
    }, error => { cache.entries.delete(key); throw error })
  cache.entries.set(key, entry)
  return entry.promise
}

// Runtime version resolution only: never mutate metadata, grants or lifecycle.
export async function resolveNpmVersions(items, env = {}) {
  const versions = new Map()
  const names = [...new Set(items.filter(item => item.npm && item.state === 'published').map(item => item.package))]
  let next = 0
  await Promise.all(Array.from({length: Math.min(6, names.length)}, async () => {
    while (next < names.length) {
      const name = names[next++]
      const item = items.find(candidate => candidate.package === name)
      versions.set(name, await versionHint(env, item?.registry === 'tokenscowork' ? 'tokenscowork' : 'npm', name))
    }
  }))
  return items.map(item => item.npm && item.state === 'published'
    ? {...item, npmLatestVersion: versions.get(item.package), versionMode: 'latest'} : item)
}

export async function liveCatalog(items, env = {}) {
  return (await resolveNpmVersions(items, env))
    // A failed lookup or prerelease latest must not advertise an obsolete install target.
    .filter(item => !item.npm || !!item.npmLatestVersion)
    .map(item => item.npm ? {...item, version: item.npmLatestVersion} : item)
}
