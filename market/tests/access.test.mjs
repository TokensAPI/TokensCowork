import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import worker from '../_worker.js'
import { fingerprint } from '../access.js'

const metadata = { id: 'private-tool', package: '@example/tool', displayName: '工具', summary: '企业工具', repository: 'https://example.com/repo', version: '1.0.0', npm: false }
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'))
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values), all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const env = { MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } },
    MARKET_PACKAGES: { get: async () => ({ body: 'private package' }) },
    ASSETS: { fetch: async () => Response.json({ publisher: { name: 'Example' }, items: [metadata] }) } }
  const call = (path, key, data) => worker.fetch(new Request('https://market.example'+path, { method: data ? 'PUT' : 'GET', headers: key ? { Authorization: `Bearer ${key}` } : {}, ...(data ? { body: JSON.stringify(data) } : {}) }), env, {})
  const restrict = () => call('/api/admin/plugins', 'admin-secret', { id: metadata.id, metadata, visibility: 'restricted', objectKey: 'private/tool.tgz' })
  const grant = (enabled = true, expiresAt = null) => call('/api/admin/keys', 'admin-secret', { apiKey: 'sk-customer-a', label: '企业 A', enabled, expiresAt, plugins: [metadata.id] })
  return { db, env, call, restrict, grant }
}
test('admin endpoints reject unauthenticated and customer credentials', async t => {
  const { call } = fixture(t)
  for (const key of [undefined, 'sk-customer-a']) assert.equal((await call('/api/admin/access', key)).status, 401)
})

test('maintenance scripts and tests are not public assets', async t => {
  const { call } = fixture(t)
  for (const path of ['/scripts/schema.sql','/tests/access.test.mjs','/%73cripts/schema.sql']) {
    assert.equal((await call(path)).status, 404)
  }
})
test('restricted catalog, roster and download require matching grant, not just any key', async t => {
  const { call, restrict, grant, db } = fixture(t)
  assert.equal((await restrict()).status, 200); assert.equal((await grant()).status, 200)
  for (const key of [undefined, 'sk-other', 'sk-customer-a']) {
    for (const path of ['/v1/plugins', '/v1/plugins/', '/roster.json']) {
      const r = await call(path, key); assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.equal((await r.json()).items.length, key === 'sk-customer-a' ? 1 : 0)
    }
    assert.equal((await call('/downloads/private-tool', key)).status, key === 'sk-customer-a' ? 200 : 403)
  }
  const state = await (await call('/api/admin/access', 'admin-secret')).text()
  assert.ok(!state.includes('sk-customer-a'))
  assert.equal(db.prepare('SELECT fingerprint FROM market_keys').get().fingerprint.length, 64)
})
test('revocation and expiry deny both catalog and download immediately', async t => {
  const { call, restrict, grant } = fixture(t); await restrict(); await grant()
  for (const [enabled, expiry] of [[false, null], [true, Date.now()-1000]]) {
    await grant(enabled, expiry)
    assert.equal((await (await call('/v1/plugins', 'sk-customer-a')).json()).items.length, 0)
    assert.equal((await call('/downloads/private-tool', 'sk-customer-a')).status, 403)
  }
})
test('database errors never fall back to unrestricted static catalog', async t => {
  const { env, call } = fixture(t)
  env.MARKET_DB.prepare = () => { throw new Error('database unavailable') }
  assert.equal((await call('/v1/plugins')).status, 503)
  assert.equal((await call('/roster.json')).status, 503)
  assert.equal((await call('/downloads/private-tool', 'sk-customer-a')).status, 503)
})
test('public plugin stays public; unconfigured download is rejected', async t => {
  const { call } = fixture(t)
  await call('/api/admin/plugins', 'admin-secret', { id: metadata.id, metadata, visibility: 'public' })
  assert.equal((await (await call('/v1/plugins')).json()).items.length, 1)
  assert.equal((await call('/downloads/private-tool')).status, 404)
})
test('malformed fields and unknown fingerprints cannot overwrite authorization', async t => {
  const { call } = fixture(t)
  assert.equal((await call('/api/admin/keys', 'admin-secret', { fingerprint: 'a'.repeat(64), label:'test', enabled:true, plugins:[] })).status, 400)
  assert.equal((await call('/api/admin/plugins', 'admin-secret', { id: metadata.id, metadata: { ...metadata, repository: 'javascript:alert(1)' }, visibility: 'restricted' })).status, 400)
})
test('HMAC fingerprint depends on server secret', async () => {
  assert.notEqual(await fingerprint('sk-test','one'), await fingerprint('sk-test','two'))
})

test('per-plugin Key editor restricts, retains, replaces and clears without changing other plugins', async t => {
  const { call, db } = fixture(t)
  const save = (apiKeys, keepFingerprints = []) => call('/api/admin/plugin-keys', 'admin-secret', { id:metadata.id, metadata, apiKeys, keepFingerprints })
  assert.equal((await save(['sk-first', 'sk-second'])).status, 200)
  assert.equal((await (await call('/roster.json')).json()).items.length, 0)
  assert.equal((await (await call('/roster.json','sk-first')).json()).items.length, 1)
  const fp = await fingerprint('sk-first','separate-secret')
  db.prepare('INSERT INTO market_grants(fingerprint,plugin_id) VALUES(?,?)').run(fp,'another-plugin')
  assert.equal((await save(['sk-third'],[fp])).status, 200)
  assert.equal((await (await call('/roster.json','sk-second')).json()).items.length, 0)
  assert.equal((await (await call('/roster.json','sk-third')).json()).items.length, 1)
  assert.equal((await save(['bad-key'])).status, 400)
  assert.equal((await save([],['f'.repeat(64)])).status, 400)
  assert.equal((await save([])).status, 200)
  assert.equal((await (await call('/roster.json')).json()).items.length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_grants WHERE plugin_id=?').get('another-plugin').n, 1)
  assert.ok(!(await (await call('/api/admin/access','admin-secret')).text()).includes('sk-first'))
})
test('required authorization configuration fails closed when database binding is missing', async t => {
  const { env, call } = fixture(t)
  env.MARKET_ACCESS_REQUIRED = 'true'; delete env.MARKET_DB
  for (const path of ['/v1/plugins','/roster.json','/downloads/private-tool']) assert.equal((await call(path)).status, 503)
})
test('cross-origin writes and oversized JSON are rejected', async t => {
  const { env } = fixture(t)
  const request = (origin, body) => new Request('https://market.example/api/admin/keys', { method:'PUT', headers:{ Authorization:'Bearer admin-secret', origin }, body })
  assert.equal((await worker.fetch(request('https://attacker.example','{}'), env, {})).status, 403)
  assert.equal((await worker.fetch(request('https://market.example', ' '.repeat(17000)), env, {})).status, 400)
})
