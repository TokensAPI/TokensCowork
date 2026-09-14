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
  // 单例必须保持唯一:上游 host-routes 用例对它整体打桩(vi.spyOn getJson),
  // 另起客户端会绕开桩子把测试请求打到真网络。授权作为可注入钩子挂在
  // 单例上,由路由侧注入;测试整桩后钩子根本不会被走到。
  // 此时 allowMarketSourceSyntheticProxy 已改写过单例(带 fake-IP 豁免),
  // 锚定其改写后的形态,把两个产品选项合并在同一次创建里。
  http = replace(http, `export const restrictedHttpClient: CatalogHttpClient = createRestrictedHttpClient({
  // 产品覆盖：产品插件源在 fake-IP 代理下解析进保留网段，加入豁免。
  syntheticProxyHostnames: ['${url.hostname}'],
})`,
    `let productMarketAuthorizationHook: ((url: URL) => Promise<string | undefined>) | undefined

/** Product overlay: install the market credential hook on the shared client. */
export function setProductMarketAuthorization(hook: (url: URL) => Promise<string | undefined>): void {
  productMarketAuthorizationHook = hook
}

export const restrictedHttpClient: CatalogHttpClient = createRestrictedHttpClient({
  // 产品覆盖：产品插件源在 fake-IP 代理下解析进保留网段，加入豁免。
  syntheticProxyHostnames: ['${url.hostname}'],
  authorization: async (url) => productMarketAuthorizationHook?.(url),
})`)
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
  routes = replace(routes, '  createRestrictedHttpClient,', '  createRestrictedHttpClient,\n  createProductMarketAuthorization,\n  setProductMarketAuthorization,')
  routes = replace(routes, '  const expectedPort = ctx.webServer.port', `  // Optional host capability; never read model-plugin files or forward unrelated keys.
  const readMarketKey = async (): Promise<string> => {
    const credentials = ctx.reflect?.get?.('credentials') as { resolve?: (ref: string) => Promise<{ value?: unknown }> } | undefined
    if (!credentials?.resolve) return ''
    const result = await credentials.resolve('TOKENSAPI_API_KEY')
    const key = typeof result?.value === 'string' ? result.value.trim() : ''
    return /^sk-\\S{1,509}$/u.test(key) ? key : ''
  }
  setProductMarketAuthorization(createProductMarketAuthorization(readMarketKey))
  let credentialIdentity: string | undefined
  const expectedPort = ctx.webServer.port`)
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
  return { http, routes, index }
}

/**
 * 产品移除了无凭据作用域的持久化目录缓存(带 Key 的目录不能落盘充当
 * 公共兜底),上游"重启后先服务持久首页"的用例断言的正是被移除的行为,
 * 按既有适配模式跳过。
 */
export function skipUpstreamPersistedCatalogTest(spec) {
  const anchor = "  it('serves the persisted first page before a restarted Host refresh completes', async () => {"
  if (!spec.includes(anchor)) {
    throw new Error('prepare-desktop: 未找到上游持久化目录缓存测试锚点，请复查市场授权测试适配')
  }
  return spec.replace(anchor, anchor.replace("  it('", "  it.skip('"))
}
