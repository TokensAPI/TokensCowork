import { registryConfig } from '../private-registry/config.mjs'

// Persisted npm entries keep their public-npm fallback for older desktops.
// Capability negotiation changes transport, never identity, grants or lifecycle.
export function selectCatalogSources(items, env, selfHostedSupported) {
  const ready = registryConfig(env).ready === true
  return items.flatMap(item => {
    if (!selfHostedSupported && item.registry === 'tokenscowork') return []
    if (selfHostedSupported && ready && item.npm && (!item.registry || item.registry === 'npm'))
      return [{ ...item, registry: 'tokenscowork' }]
    return [item]
  })
}

export function canServeRegistryPackage(metadata) {
  return metadata.npm === true && ['npm', 'tokenscowork'].includes(metadata.registry ?? 'npm')
}
