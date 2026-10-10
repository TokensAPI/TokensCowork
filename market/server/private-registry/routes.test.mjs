import test from 'node:test'
import assert from 'node:assert/strict'
import { registryRoute } from './routes.js'

function env({ registry = false, fetchImpl, granted = true, offered = false } = {}) {
  const row = { id: 'private-plugin', metadata: JSON.stringify({ npm: true, registry: 'tokenscowork', package: '@fixture/private' }), visibility: 'restricted', state: 'published' }
  // Aggregate reads run unbound, so bind() has to return the same statement rather than a
  // narrower object.
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async first() {
      if (sql.includes('FROM market_plugins') && values[0] === 'private-plugin') return row
      return null
    },
    async all() {
      if (sql.includes("kind='key'")) return { results: granted ? [{ plugin_id: 'private-plugin' }] : [] }
      if (sql.includes("kind IN ('org','user')")) return { results: offered ? [{ plugin_id: 'private-plugin' }] : [] }
      return { results: [] }
    },
  })
  const db = { prepare: sql => statement(sql) }
  return {
    MARKET_DB: db,
    MARKET_HMAC_SECRET: 'fixture-secret',
    ASSETS: { fetch: async () => Response.json({ items: [] }) },
    MARKET_PRIVATE_REGISTRY_ENABLED: registry ? 'true' : undefined,
    MARKET_PRIVATE_REGISTRY_URL: registry ? 'https://registry.example.test/' : undefined,
    MARKET_PRIVATE_REGISTRY_TOKEN: registry ? 'server-only-token' : undefined,
    fetch: fetchImpl,
  }
}

test('private Registry route fails closed when server configuration is absent', async () => {
  const request = new Request('https://market.tokensapi.ai/registry/private-plugin/%40fixture%2Fprivate', { headers: { Authorization: 'Bearer sk-fixture' } })
  const response = await registryRoute(request, env())
  assert.equal(response.status, 503)
  assert.match(await response.text(), /未配置/)
})

test('private Registry route checks market access before contacting the upstream', async () => {
  let requests = 0
  const request = new Request('https://market.tokensapi.ai/registry/private-plugin/%40fixture%2Fprivate', { headers: { Authorization: 'Bearer sk-fixture' } })
  const response = await registryRoute(request, env({ registry: true, granted: false, fetchImpl: async () => { requests += 1; throw new Error('must not fetch') } }))
  assert.equal(response.status, 403)
  assert.equal(requests, 0)
})

test('private Registry route answers an unavailable TokensAPI with 503, never a download', async () => {
  let requests = 0
  const request = new Request('https://market.tokensapi.ai/registry/private-plugin/%40fixture%2Fprivate', { headers: { Authorization: 'Bearer sk-fixture' } })
  const fixture = env({ registry: true, granted: false, offered: true, fetchImpl: async () => { requests += 1; throw new Error('must not fetch') } })
  fixture.MARKET_ORGANIZATIONS = { resolveIdentity: async () => { throw new Error('provider down') } }
  const response = await registryRoute(request, fixture)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /授权服务暂时不可用/)
  assert.equal(requests, 0)
})
