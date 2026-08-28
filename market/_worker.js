/* ============================================================
 * TokensAPI 插件市场动态目录源（Cloudflare Pages advanced mode）
 * ============================================================
 * 部署后本 worker 接管 market 目录的全部请求：
 *
 *   GET /v1/plugins   动态目录端点——从 roster.json 名册出发，对
 *                     npm: true 的条目实时查询 npm registry 的
 *                     dist-tags.latest，协作者 npm publish 后市场
 *                     5 分钟内自动同步，无需提交或重新部署。
 *   其余路径           原样回退到静态资源（source.json、admin、
 *                     roster.json、静态 v1/plugins 快照等）。
 *
 * 失败策略 fail-open：npm 查询失败用名册里的 version 兜底；名册
 * 本身读不到时回退到构建时生成的静态 v1/plugins 快照，保证市场
 * 端点永远有合法响应。
 * ============================================================ */

/** 目录响应的边缘缓存时长（秒）。市场 Host 侧另有 5 分钟索引缓存。 */
const CATALOG_TTL_SECONDS = 300

/** 目录契约只接受精确稳定版本（不能是 rc/dev 等预发布）。 */
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u

/** 组织入口路径:/t/<令牌>/source.json 与 /t/<令牌>/v1/plugins。 */
const ORG_ROUTE = /^\/t\/([A-Za-z0-9_-]{1,128})\/(source\.json|v1\/plugins)$/u

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/v1/plugins' && request.method === 'GET') {
      return catalogResponse(request, env, ctx)
    }
    const orgRoute = ORG_ROUTE.exec(url.pathname)
    if (orgRoute !== null && request.method === 'GET') {
      return orgRoute[2] === 'v1/plugins'
        ? catalogResponse(request, env, ctx, orgRoute[1])
        : orgSourceManifest(env, request.url, orgRoute[1])
    }
    if (url.pathname === '/api/latest' && request.method === 'GET') {
      return latestResponse(url)
    }
    return env.ASSETS.fetch(request)
  },
}

/**
 * 组装动态目录响应，带边缘缓存。
 *
 * 组织可见域：名册条目可带可选 `org` 标记。无标记 = 通用，所有入口可见；
 * 带标记 = 仅当调用方令牌解析出的组织与标记一致时可见。普通入口
 * (/v1/plugins) 与无效令牌都只看到通用条目——fail-open，市场永不空白。
 * @param {Request} request - 入站请求（缓存键）。
 * @param {{ ASSETS: { fetch(input: Request | string): Promise<Response> } }} env - Pages 绑定。
 * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx - 执行上下文。
 * @param {string} [token] - 组织入口的市场令牌；缺省为通用入口。
 * @returns {Promise<Response>} application/json 的目录页响应。
 */
async function catalogResponse(request, env, ctx, token) {
  const cache = caches.default
  // 缓存按入口隔离:不同令牌的目录互不串。
  const cachePath = token === undefined ? '/v1/plugins' : `/t/${token}/v1/plugins`
  const cacheKey = new Request(new URL(cachePath, request.url).toString())
  const cached = await cache.match(cacheKey)
  if (cached !== undefined) return cached

  let response
  try {
    const roster = await readRoster(env, request.url)
    const org = token === undefined ? undefined : await resolveOrg(env, request.url, token)
    const visible = roster.items.filter(item =>
      item.org === undefined || (org !== undefined && item.org === org))
    const items = await Promise.all(visible.map(item => catalogItem(item, roster.publisher)))
    response = jsonResponse({ schemaVersion: '1.0.0', items, page: {} })
  } catch {
    // 名册不可读：回退到构建时生成的静态快照，端点保持可用。
    const fallback = await env.ASSETS.fetch(new URL('/v1/plugins', request.url).toString())
    response = new Response(fallback.body, {
      status: fallback.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  if (response.status === 200) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
  }
  return response
}

/**
 * 用市场令牌解析组织 id。映射存于静态 orgs.json 的 tokens 表
 * （{ "<令牌>": "<组织id>" }）。查不到返回 undefined——调用方按通用
 * 目录处理，不报错。
 * @param {{ ASSETS: { fetch(input: string): Promise<Response> } }} env - Pages 绑定。
 * @param {string} requestUrl - 用于解析同源静态资源地址。
 * @param {string} token - 路径里的市场令牌。
 * @returns {Promise<string | undefined>} 组织 id。
 */
async function resolveOrg(env, requestUrl, token) {
  try {
    const response = await env.ASSETS.fetch(new URL('/orgs.json', requestUrl).toString())
    if (!response.ok) return undefined
    const orgs = await response.json()
    const org = orgs.tokens?.[token]
    return typeof org === 'string' && org.length > 0 ? org : undefined
  } catch {
    return undefined
  }
}

/**
 * 组织入口的目录源 manifest：基于静态 source.json，把 endpoint 改写为
 * 该令牌的目录端点（市场 Host 要求 manifest 与端点同源同路径前缀）。
 * @param {{ ASSETS: { fetch(input: string): Promise<Response> } }} env - Pages 绑定。
 * @param {string} requestUrl - 入站 URL。
 * @param {string} token - 路径里的市场令牌。
 * @returns {Promise<Response>} 改写后的 manifest 响应。
 */
async function orgSourceManifest(env, requestUrl, token) {
  const response = await env.ASSETS.fetch(new URL('/source.json', requestUrl).toString())
  if (!response.ok) return env.ASSETS.fetch(requestUrl)
  const manifest = await response.json()
  const origin = new URL(requestUrl).origin
  manifest.transport = { ...manifest.transport, endpoint: `${origin}/t/${token}/v1/plugins` }
  return jsonResponse(manifest)
}

/**
 * 读取并校验名册文件。
 * @param {{ ASSETS: { fetch(input: string): Promise<Response> } }} env - Pages 绑定。
 * @param {string} requestUrl - 用于解析同源静态资源地址。
 * @returns {Promise<{ publisher: object, items: object[] }>} 名册内容。
 * @throws 名册缺失或形状不对时抛出（由调用方走静态快照兜底）。
 */
async function readRoster(env, requestUrl) {
  const response = await env.ASSETS.fetch(new URL('/roster.json', requestUrl).toString())
  if (!response.ok) throw new Error(`roster.json ${response.status}`)
  const roster = await response.json()
  if (!Array.isArray(roster.items) || typeof roster.publisher !== 'object') {
    throw new Error('roster.json shape mismatch')
  }
  return roster
}

/**
 * 由一条名册记录构造目录 item。npm 管理的条目实时解析最新稳定版。
 * @param {object} item - 名册记录。
 * @param {object} publisher - 名册级 publisher。
 * @returns {Promise<object>} catalog-provider-page 1.0.0 的 item。
 */
async function catalogItem(item, publisher) {
  const version = item.npm === true
    ? await latestStableVersion(item.package, item.version)
    : item.version
  return {
    id: item.id,
    name: item.package,
    displayName: item.displayName,
    summary: item.summary,
    homepage: item.repository,
    latestVersion: version,
    repository: { url: item.repository },
    ...(item.npm === true ? { package: { registry: 'npm', name: item.package } } : {}),
    publisher,
  }
}

/**
 * 查询 npm registry 的 latest dist-tag；失败或非稳定版时用名册
 * 版本兜底（fail-open，市场 Host 预览时还会独立核验 npm）。
 * @param {string} packageName - npm 包名。
 * @param {string} fallback - 名册里记录的版本。
 * @returns {Promise<string>} 精确稳定版本号。
 */
async function latestStableVersion(packageName, fallback) {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/-/package/${packageName}/dist-tags`,
      { headers: { accept: 'application/json' }, cf: { cacheTtl: 120, cacheEverything: true } },
    )
    if (!response.ok) return fallback
    const tags = await response.json()
    const latest = typeof tags.latest === 'string' ? tags.latest : ''
    return STABLE_VERSION.test(latest) ? latest : fallback
  } catch {
    return fallback
  }
}

/**
 * 管理面板专用:服务端代查一个 npm 包的 latest dist-tag。面板浏览器
 * 直连 registry 会被 CORS 与网络环境拦下,改为同源问本端点。
 * @param {URL} url - 入站 URL,查询参数 pkg 为 npm 包名。
 * @returns {Promise<Response>} { pkg, latest } 或 400/502 错误说明。
 */
async function latestResponse(url) {
  const pkg = url.searchParams.get('pkg') ?? ''
  // 校验 npm 包名的合法形状,防止把任意路径拼进 registry 请求。
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(pkg)) {
    return jsonResponse({ error: 'invalid pkg' }, 400)
  }
  try {
    const response = await fetch(
      `https://registry.npmjs.org/-/package/${pkg}/dist-tags`,
      { headers: { accept: 'application/json' }, cf: { cacheTtl: 120, cacheEverything: true } },
    )
    if (!response.ok) return jsonResponse({ pkg, latest: null }, 200)
    const tags = await response.json()
    return jsonResponse({ pkg, latest: typeof tags.latest === 'string' ? tags.latest : null })
  } catch {
    return jsonResponse({ pkg, latest: null })
  }
}

/**
 * 构造符合市场 Host 要求的 JSON 响应。
 * @param {object} body - 响应对象。
 * @param {number} [status] - HTTP 状态码,默认 200。
 * @returns {Response} Content-Type 为 application/json 的响应。
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=60, s-maxage=${CATALOG_TTL_SECONDS}`,
    },
  })
}
