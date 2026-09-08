// Build-only overlay: optional credential capability, no model-plugin dependency.
function replace(source, anchor, value) {
  if (source.split(anchor).length !== 2) throw new Error('market-auth: upstream anchor changed: '+anchor)
  return source.replace(anchor, value)
}

export function addMarketAuth({ http, routes, index }, origin) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('market-auth: HTTPS origin required')
  http = replace(http, '  readonly syntheticProxyHostnames?: readonly string[]',
    '  readonly authorization?: (url: URL) => Promise<string | undefined>\n  readonly syntheticProxyHostnames?: readonly string[]')
  http = replace(http, '  maxBodyBytes: number,\n): Promise<RestrictedHttpResponse>',
    '  maxBodyBytes: number,\n  authorization?: string,\n): Promise<RestrictedHttpResponse>')
  http = replace(http, "        accept: 'application/json',", "        ...(authorization ? { authorization } : {}),\n        accept: 'application/json',")
  http = replace(http, 'await requestOnce(url, signal, pinned, maxBodyBytes)',
    'await requestOnce(url, signal, pinned, maxBodyBytes, await options.authorization?.(url))')
  http += `
export function createProductMarketAuthorization(readKey: () => Promise<string>) {
  return async (url: URL): Promise<string | undefined> => {
    if (url.origin !== ${JSON.stringify(origin)} || !['/v1/plugins', '/v1/plugins/', '/roster.json'].includes(url.pathname)) return undefined
    const key = await readKey()
    return /^sk-\\S{1,509}$/u.test(key) ? 'Bearer ' + key : undefined
  }
}
`
  routes = `import { createHash } from 'node:crypto'\n` + routes
  routes = replace(routes, '  createRestrictedHttpClient,', '  createRestrictedHttpClient,\n  createProductMarketAuthorization,')
  routes = replace(routes, '  const expectedPort = ctx.webServer.port', `  // Optional host capability; never read model-plugin files or forward unrelated keys.
  const readMarketKey = async (): Promise<string> => {
    const credentials = Reflect.get(ctx, 'credentials') as { resolve?: (ref: string) => Promise<{ value?: unknown }> } | undefined
    if (!credentials?.resolve) return ''
    const result = await credentials.resolve('TOKENSAPI_API_KEY')
    const key = typeof result?.value === 'string' ? result.value.trim() : ''
    return /^sk-\\S{1,509}$/u.test(key) ? key : ''
  }
  const productHttp = createRestrictedHttpClient({
    syntheticProxyHostnames: [${JSON.stringify(url.hostname)}],
    authorization: createProductMarketAuthorization(readMarketKey),
  })
  let credentialIdentity: string | undefined
  const expectedPort = ctx.webServer.port`)
  routes = replace(routes, 'new DefaultCatalogService(store, restrictedHttpClient, {', 'new DefaultCatalogService(store, productHttp, {')
  // Leave upstream imports used for other source-management paths intact.
  routes = replace(routes, "\n        const requestUrl = new URL(req.url ?? '/', 'http://localhost')", `
        const identity = createHash('sha256').update(await readMarketKey()).digest('hex')
        if (credentialIdentity !== identity) {
          for (const source of await service.listSources()) service.invalidateSource(source.sourceRecordId)
          credentialIdentity = identity
        }
        const requestUrl = new URL(req.url ?? '/', 'http://localhost')`)
  routes = replace(routes, 'cachedCatalogResponse(settingsScope.get().catalogCache, activeSource, localeKey)',
    'cachedCatalogResponse(undefined, activeSource, localeKey)')
  routes = replace(routes, '    if (cache !== undefined) await scope.update({ catalogCache: cache })',
    '    // Credential-specific catalogs must not be persisted as an unscoped fallback.\n    void cache')
  routes = replace(routes, '  const settingsScope = scope\n', '')
  index = replace(index, "export const inject = ['webServer', 'settings']", "export const inject = { required: ['webServer', 'settings'], optional: ['credentials'] }")
  return { http, routes, index }
}
