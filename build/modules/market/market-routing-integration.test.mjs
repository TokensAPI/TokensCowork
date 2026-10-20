import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createD1Database, createTarballCache } from '../../../market/server/runtime/adapters.mjs'
import { fingerprint } from '../../../market/server/security/key-fingerprint.js'
import { registryRoute } from '../../../market/server/private-registry/routes.js'

const ARCHIVE = 'fixture-archive'
const INTEGRITY = `sha512-${createHash('sha512').update(ARCHIVE).digest('base64')}`

test('shared registry: real SQLite, independent Key ACLs, tarball checks and revocation', async t => {
  const db = createD1Database(':memory:', fileURLToPath(new URL('../../../market/server/database/migrations/', import.meta.url)))
  const cacheDir = mkdtempSync(join(tmpdir(), 'market-archive-cache-'))
  t.after(() => { try { rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3 }) } catch {} })
  const secret = 'local-fixture-secret'
  const key = 'sk-test-registry-fixture'
  let upstream = 0
  // 设成一个未完成的 promise，就能把上游归档卡在半路。
  let gate
  const env = { MARKET_DB: db, MARKET_HMAC_SECRET: secret,
    MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example/',
    MARKET_PRIVATE_REGISTRY_TOKEN: 'server-fixture',
    ASSETS: { fetch: async () => Response.json({ items: [] }) },
    MARKET_TARBALL_CACHE: createTarballCache(cacheDir),
    fetch: async (url, options) => {
      upstream++
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer server-fixture')
      if (String(url).endsWith('.tgz')) {
        const pending = gate
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(ARCHIVE.slice(0, 7)))
            await pending
            controller.enqueue(new TextEncoder().encode(ARCHIVE.slice(7)))
            controller.close()
          },
        }))
      }
      const name = decodeURIComponent(new URL(url).pathname.slice(1))
      return Response.json({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0', dist: { tarball: 'https://registry.example/fixture.tgz', integrity: INTEGRITY } } } })
    },
  }
  async function seed(id, name, visibility = 'restricted', state = 'published') {
    await db.prepare('INSERT INTO market_plugins(id,visibility,state,metadata) VALUES(?,?,?,?)').bind(id, visibility, state, JSON.stringify({ package: name, npm: true, registry: 'tokenscowork' })).run()
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
    await db.prepare("INSERT INTO market_keys(fingerprint,label) VALUES(?,'fixture')").bind(fp).run()
    await db.prepare("INSERT INTO market_grants(plugin_id,kind,subject) VALUES(?,'key',?)").bind('qa-a', fp).run()
    for (const path of ['by-package/%40tokensapi%2Fqa-a', 'by-package/@tokensapi/qa-a']) {
      assert.equal((await request(path)).status, 403)
      assert.equal((await request(path, 'sk-wrong')).status, 403)
      const metadata = await request(path, key)
      assert.equal(metadata.status, 200)
      const tarball = (await metadata.json()).versions['1.0.0'].dist.tarball
      assert.match(tarball, /\/registry\/qa-a\//)
      const route = new URL(tarball).pathname.slice('/registry/'.length)
      assert.equal((await request(route)).status, 403)
      const archive = await request(route, key)
      assert.equal(archive.status, 200)
      // 边拉边回，内容一字不改；读完才算一次完整下载。
      assert.equal(await archive.text(), ARCHIVE)
    }
    // 首字节不等整包：上游 body 还卡在半路时，归档响应已经回来了。
    let release
    gate = new Promise(resolve => { release = resolve })
    const streaming = await request('qa-open/qa-unscoped/1.0.0/tarball')
    assert.equal(streaming.status, 200)
    release()
    gate = undefined
    assert.equal(await streaming.text(), ARCHIVE)

    // 同一版本第二次下载走本地缓存，不再回源。
    const cached = upstream
    const repeat = await request('qa-a/%40tokensapi%2Fqa-a/1.0.0/tarball', key)
    assert.equal(repeat.status, 200)
    assert.equal(await repeat.text(), ARCHIVE)
    assert.equal(upstream, cached, '已验证过的同一版本不应再回源')
    const before = upstream
    for (const path of ['by-package/%40tokensapi%2Fqa-b', 'by-package/%40tokensapi%2Fqa-draft', 'qa-a/%40tokensapi%2Fqa-b', 'by-package/%40tokensapi%2Fmissing']) assert.equal((await request(path, key)).status, 403)
    assert.equal(upstream, before, 'unauthorized requests must not reach Registry')
    assert.equal((await request('by-package/qa-unscoped')).status, 200)
    assert.equal((await request('by-package/%ZZ')).status, 400)
    await db.prepare('DELETE FROM market_grants WHERE plugin_id=?').bind('qa-a').run()
    assert.equal((await request('by-package/%40tokensapi%2Fqa-a', key)).status, 403)
    // 撤权后连已缓存的归档也不发：缓存只是存储，授权判断在它之前。
    assert.equal((await request('qa-a/%40tokensapi%2Fqa-a/1.0.0/tarball', key)).status, 403)
    await seed('qa-duplicate', 'qa-unscoped', 'public')
    assert.equal((await request('by-package/qa-unscoped')).status, 403, 'ambiguous package identity must fail closed')
  } finally { globalThis.fetch = originalFetch; db.close() }
})
