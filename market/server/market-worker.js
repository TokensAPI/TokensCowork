import { accessRoute } from './routes/admin-access-routes.js'
import { filterRoster } from './services/plugin-access-service.js'
import { catalogRoster } from './services/catalog-service.js'
import { liveCatalog } from './services/npm-version-service.js'
import { reply } from './http/response.js'
import { registryRoute } from './registry/routes.js'

const publicHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const admin = await accessRoute(request, env)
    if (admin) return admin
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
        const roster = await filterRoster(
          request,
          env,
          await catalogRoster(env),
        )
        roster.items = await liveCatalog(roster.items, env)
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
      '/admin/assets/market-admin.js',
      '/admin/assets/market-api.js',
      '/admin/assets/market-model.js',
      '/admin/assets/market-admin.css',
      '/admin/assets/market-theme.js',
      '/admin/assets/market-theme.css',
      '/admin/assets/market-catalog-editor.js',
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
