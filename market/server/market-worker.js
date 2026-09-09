import { accessRoute } from './routes/admin-access-routes.js'
import { filterRoster } from './services/plugin-access-service.js'
import { catalogRoster } from './services/catalog-service.js'
import { liveCatalog } from './services/npm-version-service.js'
import { reply } from './http/response.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const admin = await accessRoute(request, env)
    if (admin) return admin
    if (
      ['/v1/plugins', '/v1/plugins/', '/roster.json'].includes(url.pathname)
    ) {
      if (request.method !== 'GET')
        return reply({ error: 'method not allowed' }, 405)
      if (!env.MARKET_DB || !env.MARKET_HMAC_SECRET)
        return reply({ error: '市场数据库未配置' }, 503)
      try {
        const roster = await filterRoster(
          request,
          env,
          await catalogRoster(env),
        )
        roster.items = await liveCatalog(roster.items)
        if (url.pathname === '/roster.json')
          return reply({
            publisher: roster.publisher,
            items: roster.items.map(publicMetadata),
          })
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
                ? { package: { registry: 'npm', name: item.package } }
                : {}),
              ...(item.installSource
                ? { installSource: item.installSource }
                : {}),
            }
          }),
        )
        return reply({ schemaVersion: '1.0.0', items, page: {} })
      } catch {
        return reply({ error: '授权目录暂时不可用' }, 503)
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
    return env.ASSETS.fetch(request)
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
    ...(item.installSource ? { installSource: item.installSource } : {}),
  }
}
