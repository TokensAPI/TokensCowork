/** Pure view-model helpers shared by the console and its regression tests. */
const rows = (value) => (Array.isArray(value) ? value : [])

/**
 * The plugin list as the console shows it: the product's built-in components first (read-only),
 * then the market's own plugins. A market row that duplicates a built-in is hidden.
 */
export function mergePlugins(catalog) {
  const components = rows(catalog?.components?.items).filter((p) => p?.id)
    .map((p) => ({ ...p, category: 'builtin', state: 'builtin', productVersion: catalog.components.productVersion }))
  const ids = new Set(components.map((p) => p.id)), packages = new Set(components.map((p) => p.package))
  return [...components, ...rows(catalog?.items)
    .filter((p) => p?.id && p.category !== 'builtin' && !ids.has(p.id) && !packages.has(p.package))
    .map((p) => ({ ...p, category: 'optional' }))]
}

/** Stage, scope and text filters. Built-ins are always public: the market cannot restrict them. */
export function filterPlugins(plugins, { query = '', stage = 'all', visibility = 'all' } = {}) {
  const search = String(query).trim().toLocaleLowerCase()
  return rows(plugins).filter((plugin) => {
    const scope = plugin.category === 'builtin' ? 'public' : plugin.visibility
    const inStage = stage === 'all' ? plugin.state !== 'deleted'
      : stage === 'builtin' ? plugin.category === 'builtin' : plugin.state === stage
    return inStage && (visibility === 'all' || visibility === scope) &&
      (!search || [plugin.id, plugin.displayName, plugin.package, plugin.summary]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(search))
  })
}
