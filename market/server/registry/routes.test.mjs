import test from 'node:test'
import assert from 'node:assert/strict'
import { registryRoute } from './routes.js'

function env({ registry = false, fetchImpl, granted = true } = {}) {
  const row = { id: 'private-plugin', metadata: JSON.stringify({ npm: true, registry: 'tokenscowork', package: '@fixture/private' }), visibility: 'restricted', state: 'published' }
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('FROM market_plugins') && values[0] === 'private-plugin') return row
              if (sql.includes('market_org_policies')) return null
              if (sql.includes('market_keys')) return granted ? { fingerprint: 'fixture' } : null
              return null
            },
            async all() { return { results: [] } },
          }
        },
      }
    },
  }
  return {
    MARKET_DB: db,
    MARKET_HMAC_SECRET: 'fixture-secret',
    MARKET_PRIVATE_REGISTRY_ENABLED: registry ? 'true' : undefined,
    MARKET_PRIVATE_REGISTRY_URL: registry ? 'https://registry.example.test/' : undefined,
    MARKET_PRIVATE_REGISTRY_TOKEN: registry ? 'server-only-token' : undefined,
    fetch: fetchImpl,
  }
}

test('private Registry route fails closed when server configuration is absent', async () => {
  const request = new Request('https://tokenscowork-market.pages.dev/registry/private-plugin/%40fixture%2Fprivate', { headers: { Authorization: 'Bearer sk-fixture' } })
  const response = await registryRoute(request, env())
  assert.equal(response.status, 503)
  assert.match(await response.text(), /未配置/)
})

test('private Registry route checks market access before contacting the upstream', async () => {
  let requests = 0
  const request = new Request('https://tokenscowork-market.pages.dev/registry/private-plugin/%40fixture%2Fprivate', { headers: { Authorization: 'Bearer sk-fixture' } })
  const response = await registryRoute(request, env({ registry: true, granted: false, fetchImpl: async () => { requests += 1; throw new Error('must not fetch') } }))
  assert.equal(response.status, 403)
  assert.equal(requests, 0)
})
