import { apiRoute } from './routes/api.js'
import { filterRoster } from './services/access.js'
import { catalogRoster } from './services/plugins.js'
import { liveCatalog, invalidateVersionHints } from './services/npm-version-service.js'
import { reply } from './http/response.js'
import { registryRoute } from './private-registry/routes.js'
import { selectCatalogSources } from './services/catalog-source-service.js'
import { localizeCatalog } from './services/catalog-locale-service.js'
import { sessionLogUpload } from './services/session-logs.js'
import { readerPluginDocs, readerPlugins } from './services/docs.js'

// The documentation center reads with the reader's own Key (or the administrator's console session)
// and must never be cached or shared.
const readerHeaders = { 'cache-control': 'no-store', vary: 'Authorization, Cookie' }

/** GET /v1/docs: the plugins this Key may see; GET /v1/docs/{pluginId}: that plugin's pages. */
async function docsRoute(request, env, url) {
  if (request.method !== 'GET') return reply({ error: 'method not allowed' }, 405, readerHeaders)
  if (!env.MARKET_DB || !env.MARKET_HMAC_SECRET) return reply({ error: '市场数据库未配置' }, 503, readerHeaders)
  const segments = url.pathname.split('/').filter(Boolean).slice(2)
  if (segments.length > 1) return reply({ error: 'not found' }, 404, readerHeaders)
  try {
    const result = segments.length === 0
      ? await readerPlugins(request, env, url.searchParams.get('locale') || 'zh-CN')
      : await readerPluginDocs(request, env, decodeURIComponent(segments[0]))
    return reply(result, 200, readerHeaders)
  } catch (error) {
    if ([401, 404, 503].includes(error?.status)) return reply({ error: error.message }, error.status, readerHeaders)
    return reply({ error: '文档中心暂时不可用' }, 503, readerHeaders)
  }
}

const publicHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, X-Dsh-Catalog-Registries',
  vary: 'Authorization, X-Dsh-Catalog-Registries',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const api = await apiRoute(request, env)
    if (api) {
      if (api.ok && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) invalidateVersionHints(env)
      return api
    }
    if (url.pathname === '/v1/session-logs') return sessionLogUpload(request, env)
    if (url.pathname === '/v1/docs' || url.pathname.startsWith('/v1/docs/')) return docsRoute(request, env, url)
    // The documentation center's page. It is served from the console's folder so it carries the
    // console's security headers, but its address is /docs.
    if (url.pathname === '/docs' || url.pathname === '/docs/') {
      if (!['GET', 'HEAD'].includes(request.method)) return reply({ error: 'method not allowed' }, 405)
      return env.ASSETS.fetch(new Request(new URL('/admin/docs.html', url), { method: request.method, headers: request.headers }))
    }
    if (url.pathname.startsWith('/registry/')) return registryRoute(request, env)
    if (
      ['/v1/plugins', '/v1/plugins/', '/roster.json'].includes(url.pathname)
    ) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: publicHeaders })
      if (request.method !== 'GET')
        return reply({ error: 'method not allowed' }, 405, publicHeaders)
      if (!env.MARKET_DB || !env.MARKET_HMAC_SECRET)
        return reply({ error: '市场数据库未配置' }, 503, publicHeaders)
      try {
        const locale = url.searchParams.get('locale') || 'zh-CN'
        const roster = await filterRoster(
          request,
          env,
          await catalogRoster(env),
        )
        // Desktop builds before 0.4.11 validate listings against a schema whose
        // package registry is exactly "npm", and a single self-hosted entry fails
        // the whole page — the market would go blank on those installs. Entries
        // from the self-hosted Registry are therefore only listed to clients that
        // declare support for them; every other client keeps receiving exactly
        // the payload shape it always received.
        const declared = (request.headers.get('x-dsh-catalog-registries') ?? '').toLowerCase().split(/[\s,]+/u)
        roster.items = selectCatalogSources(roster.items, env, declared.includes('tokenscowork'))
        roster.items = await liveCatalog(roster.items, env)
        roster.items = await localizeCatalog(roster.items, env, locale)
        if (url.pathname === '/roster.json')
          return reply({
            publisher: roster.publisher,
            items: roster.items.map(publicMetadata),
          }, 200, publicHeaders)
        const items = await Promise.all(
          roster.items.map(async (item) => {
            return {
              id: item.id,
              name: item.package,
              displayName: item.displayName,
              summary: item.summary,
              homepage: item.repository || 'https://www.npmjs.com/package/' + item.package,
              latestVersion: item.version,
              ...(item.repository ? { repository: { url: item.repository } } : {}),
              publisher: roster.publisher,
              ...(item.npm
                ? { package: { registry: item.registry === 'tokenscowork' ? 'tokenscowork' : 'npm', name: item.package } }
                : {}),
              ...(item.installSource
                ? { installSource: item.installSource }
                : {}),
            }
          }),
        )
        return reply({ schemaVersion: '1.0.0', items, page: {} }, 200, publicHeaders)
      } catch {
        return reply({ error: '授权目录暂时不可用' }, 503, publicHeaders)
      }
    }
    // No static plugin snapshot: outages must never resurrect unpublished entries.
    const assets = new Set([
      '/source.json',
      '/admin/',
      '/admin/index.html',
      '/admin/access.html',
      '/admin/api-docs.html',
      '/admin/assets/brand.css',
      '/admin/assets/logo-mark.svg',
      '/admin/assets/fonts/Quicksand-Variable.ttf',
      '/admin/assets/fonts/OFL.txt',
      '/admin/assets/api-docs.js',
      '/admin/assets/api-docs.css',
      '/admin/assets/openapi.json',
      '/admin/assets/vendor/swagger-ui.css',
      '/admin/assets/vendor/swagger-ui-bundle.js',
      '/admin/assets/market-admin.js',
      '/admin/assets/market-api.js',
      '/admin/assets/market-model.js',
      '/admin/assets/market-admin.css',
      '/admin/assets/market-theme.js',
      '/admin/assets/market-theme.css',
      '/admin/assets/market-catalog-editor.js',
      '/admin/assets/market-organizations.js',
      '/admin/assets/market-keys.js',
      '/admin/assets/market-users.js',
      '/admin/assets/market-grants.js',
      '/admin/assets/market-session-logs.js',
      '/admin/assets/market-session-log-detail.js',
      '/admin/assets/market-session-log-replay.js',
      '/admin/assets/market-markdown.js',
      // The plugin documentation center (page at /docs) and the console's docs page.
      '/admin/assets/market-docs.js',
      '/admin/assets/market-docs.css',
      '/admin/assets/market-docs-admin.js',
    ])
    if (!assets.has(url.pathname)) return reply({ error: 'not found' }, 404)
    if (url.pathname === '/source.json' && request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: publicHeaders })
    const response = await env.ASSETS.fetch(request)
    if (url.pathname !== '/source.json') return response
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(publicHeaders)) headers.set(key, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
function publicMetadata(item) {
  return {
    id: item.id,
    category: 'optional',
    package: item.package,
    displayName: item.displayName,
    summary: item.summary,
    repository: item.repository,
    version: item.version,
    npm: item.npm,
    ...(item.registry ? { registry: item.registry } : {}),
    ...(item.installSource ? { installSource: item.installSource } : {}),
  }
}
