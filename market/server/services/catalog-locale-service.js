import { npmVersionManifest } from '../integrations/npm-registry.js'
import { createRegistryClient } from '../private-registry/client.mjs'

const caches = new WeakMap()
export function localeMap(value, max) {
  const result = Object.create(null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, text] of Object.entries(value).slice(0, 32)) {
    if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(key) && typeof text === 'string' && text.trim() && text.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) result[key.toLowerCase()] = text.trim()
  }
  return result
}
export function localized(fallback, values, locale, max = 1000) {
  const map = localeMap(values, max)
  const key = String(locale || 'zh-CN').toLowerCase()
  const language = key.split('-')[0]
  return map[key] || map[language] || map[Object.keys(map).sort().find(k => k.startsWith(language + '-'))] || map['zh-cn'] || map.zh || fallback
}
async function metadata(item, env) {
  const identity = JSON.stringify([env.MARKET_PRIVATE_REGISTRY_URL, env.MARKET_PRIVATE_REGISTRY_TOKEN, env.MARKET_PRIVATE_REGISTRY_AUTH_SCHEME, env.MARKET_PRIVATE_REGISTRY_ENABLED])
  let cache = caches.get(env)
  if (!cache || cache.identity !== identity) { cache = {identity, entries:new Map()}; caches.set(env, cache) }
  const key = JSON.stringify([item.registry, item.package, item.version])
  const old = cache.entries.get(key)
  if (old && old.until > Date.now()) return old.promise
  if (cache.entries.size >= 256) cache.entries.delete(cache.entries.keys().next().value)
  const promise = (async () => {
    try {
      const result = item.registry === 'tokenscowork'
        ? await createRegistryClient(env).resolve(item.package, item.version)
        : {ok:true, manifest:await npmVersionManifest(item.package, item.version)}
      return result.ok ? result.manifest?.tokenscowork : undefined
    } catch { return undefined }
  })()
  cache.entries.set(key, {promise, until:Date.now() + 180_000})
  return promise
}
// Authorization and source selection happen before this presentation-only step.
export async function localizeCatalog(items, env, locale) {
  const result = [...items]
  let next = 0
  await Promise.all(Array.from({length:Math.min(6, items.length)}, async () => {
    while (next < items.length) {
      const index = next++, item = items[index]
      const value = item.npm ? await metadata(item, env) : undefined
      result[index] = {...item,
        displayName:localized(item.displayName, value?.displayName, locale, 120),
        summary:localized(item.summary, value?.summary, locale),
      }
    }
  }))
  return result
}
