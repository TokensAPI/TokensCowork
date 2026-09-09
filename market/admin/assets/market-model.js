/** Pure view-model helpers shared by the console and its regression tests. */
const rows = (value) => (Array.isArray(value) ? value : [])

/** Catalog API is authoritative. Never resurrect removed entries from ACL rows. */
export function mergePlugins(catalog) {
  return rows(Array.isArray(catalog) ? catalog : catalog?.items)
    .filter((p) => p?.id && p.category !== 'builtin')
    .map((p) => ({ ...p, category: 'optional' }))
}

/** Returns explicit grants after migration, otherwise active, unexpired legacy grants. */
export function keyGrants(state, id, now = Date.now()) {
  if (
    rows(state?.organizationPolicies).some((policy) => policy.plugin_id === id)
  ) {
    return [
      ...new Set(
        rows(state?.directKeyGrants)
          .filter((grant) => grant.plugin_id === id)
          .map((grant) => grant.fingerprint),
      ),
    ]
  }
  const active = new Set(
    rows(state?.keys)
      .filter(
        (key) =>
          (key.enabled === true || key.enabled === 1) &&
          (key.expires_at == null || key.expires_at > now),
      )
      .map((key) => key.fingerprint),
  )
  return [
    ...new Set(
      rows(state?.grants)
        .filter(
          (grant) => grant.plugin_id === id && active.has(grant.fingerprint),
        )
        .map((grant) => grant.fingerprint),
    ),
  ]
}

/** Category and visibility are independent. Built-ins cannot be market-restricted. */
export function filterPlugins(
  plugins,
  state,
  { query = '', category = 'all', visibility = 'all', stage = 'all' } = {},
) {
  const search = String(query).trim().toLocaleLowerCase()
  const restricted = new Set(
    rows(state?.plugins)
      .filter((plugin) => plugin.visibility === 'restricted')
      .map((plugin) => plugin.id),
  )
  return rows(plugins).filter((plugin) => {
    const builtin = plugin.category === 'builtin'
    const actualCategory = builtin ? 'builtin' : 'optional'
    const actualVisibility =
      !builtin && restricted.has(plugin.id) ? 'restricted' : 'public'
    return (
      (stage === 'all' ? plugin.state !== 'deleted' : plugin.state === stage) &&
      (category === 'all' || category === actualCategory) &&
      (visibility === 'all' || visibility === actualVisibility) &&
      (!search ||
        [plugin.id, plugin.displayName, plugin.package, plugin.summary]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(search))
    )
  })
}

/** Splits pasted lines without altering opaque, case-sensitive API Key values. */
export function parseKeys(text) {
  return [
    ...new Set(
      String(text ?? '')
        .split(/\r\n?|\n/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
}

/** Existing plaintext values may be omitted for legacy fingerprint-only records. */
export function effectiveNewKeys(text, existingValues = []) {
  const existing = new Set(
    rows(existingValues).filter((value) => typeof value === 'string'),
  )
  return parseKeys(text).filter((key) => !existing.has(key))
}
