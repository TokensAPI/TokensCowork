import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createD1Database } from '../../../market/server/runtime/adapters.mjs'
import { fingerprint } from '../../../market/server/security/key-fingerprint.js'
import { patchRegistryRoutes } from './market-routing-overlay.mjs'

const routeFile = new URL('../../../market/server/private-registry/routes.js', import.meta.url)
const raw = await readFile(routeFile, 'utf8')
const source = patchRegistryRoutes(raw).replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path, routeFile).href}'`)
const { registryRoute } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

test('shared registry: real SQLite, independent Key ACLs, tarball checks and revocation', async () => {
  const db = createD1Database(':memory:', fileURLToPath(new URL('../../../market/server/database/migrations/', import.meta.url)))
  const secret = 'local-fixture-secret'
  const key = 'sk-test-registry-fixture'
  let upstream = 0
  const env = { MARKET_DB: db, MARKET_HMAC_SECRET: secret,
    MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example/',
    MARKET_PRIVATE_REGISTRY_TOKEN: 'server-fixture',
    fetch: async (url, options) => {
      upstream++
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer server-fixture')
      if (String(url).endsWith('.tgz')) return new Response('fixture-archive')
      const name = decodeURIComponent(new URL(url).pathname.slice(1))
      return Response.json({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0', dist: { tarball: 'https://registry.example/fixture.tgz' } } } })
    },
  }
  async function seed(id, name, visibility = 'restricted', state = 'published') {
    await db.prepare('INSERT INTO market_plugins(id,visibility,metadata) VALUES(?,?,?)').bind(id, visibility, JSON.stringify({ package: name, npm: true, registry: 'tokenscowork' })).run()
    await db.prepare('INSERT INTO market_catalog(id,state) VALUES(?,?)').bind(id, state).run()
    await db.prepare('INSERT INTO market_org_policies(plugin_id) VALUES(?)').bind(id).run()
  }
  const request = (path, token = '') => registryRoute(new Request('https://market.example/registry/' + path, { headers: token ? { authorization: 'Bearer ' + token } : {} }), env)
  const originalFetch = globalThis.fetch
  globalThis.fetch = env.fetch
  try {
    await seed('qa-a', '@tokensapi/qa-a')
    await seed('qa-b', '@tokensapi/qa-b')
    await seed('qa-open', 'qa-unscoped', 'public')
    await seed('qa-draft', '@tokensapi/qa-draft', 'public', 'draft')
    const fp = await fingerprint(key, secret)
    await db.prepare('INSERT INTO market_plugin_key_grants(plugin_id,fingerprint) VALUES(?,?)').bind('qa-a', fp).run()
    for (const path of ['by-package/%40tokensapi%2Fqa-a', 'by-package/@tokensapi/qa-a']) {
      assert.equal((await request(path)).status, 403)
      assert.equal((await request(path, 'sk-wrong')).status, 403)
      const metadata = await request(path, key)
      assert.equal(metadata.status, 200)
      const tarball = (await metadata.json()).versions['1.0.0'].dist.tarball
      assert.match(tarball, /\/registry\/qa-a\//)
      const route = new URL(tarball).pathname.slice('/registry/'.length)
      assert.equal((await request(route)).status, 403)
      assert.equal((await request(route, key)).status, 200)
    }
    const before = upstream
    for (const path of ['by-package/%40tokensapi%2Fqa-b', 'by-package/%40tokensapi%2Fqa-draft', 'qa-a/%40tokensapi%2Fqa-b', 'by-package/%40tokensapi%2Fmissing']) assert.equal((await request(path, key)).status, 403)
    assert.equal(upstream, before, 'unauthorized requests must not reach Registry')
    assert.equal((await request('by-package/qa-unscoped')).status, 200)
    assert.equal((await request('by-package/%ZZ')).status, 400)
    await db.prepare('DELETE FROM market_plugin_key_grants WHERE plugin_id=?').bind('qa-a').run()
    assert.equal((await request('by-package/%40tokensapi%2Fqa-a', key)).status, 403)
    assert.equal((await request('qa-a/%40tokensapi%2Fqa-a/1.0.0/tarball', key)).status, 403)
    await seed('qa-duplicate', 'qa-unscoped', 'public')
    assert.equal((await request('by-package/qa-unscoped')).status, 403, 'ambiguous package identity must fail closed')
  } finally { globalThis.fetch = originalFetch; db.close() }
})
