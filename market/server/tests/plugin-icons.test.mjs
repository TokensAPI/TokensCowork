import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from '../_worker.js'
import { createAssets } from '../runtime/adapters.mjs'
import { resetTestCatalog, seedTestPlugin } from './catalog-fixture.mjs'

// Independent fixtures: no production credentials, npm or organization requests.
const ORIGIN = 'https://market.example'
const plugin = id => ({ id, package: '@example/' + id, displayName: id + ' name', summary: id, repository: 'https://example.com/' + id, version: '1.0.0', npm: false })
// The smallest byte strings that carry each format's signature; only the signature is checked here.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const WEBP = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
const base64 = bytes => Buffer.from(bytes).toString('base64')

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  resetTestCatalog(db, plugin('public-tool'))
  seedTestPlugin(db, plugin('hidden-tool'))
  db.exec("UPDATE market_plugins SET visibility='restricted',revision=revision+1 WHERE id='hidden-tool'")
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values), all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const env = { MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret', MARKET_KEY_ENCRYPTION_SECRET: 'test-encryption-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } },
    ASSETS: createAssets(resolve(fileURLToPath(new URL('..', import.meta.url)))),
    MARKET_ORGANIZATIONS: { resolveIdentity: async key => key === 'sk-reader' ? { organization: null, user: { id: 7, name: 'Reader' } } : { organization: null, user: null } } }
  const call = (path, { key, data, method = data === undefined ? 'GET' : 'PUT' } = {}) => worker.fetch(new Request(ORIGIN + path, { method,
    headers: key ? { Authorization: `Bearer ${key}` } : {}, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
  const upload = (id, contentType, bytes) => call(`/api/v1/plugins/${id}/icon`, { key: 'admin-secret', data: { contentType, data: base64(bytes) } })
  return { db, call, upload }
}

test('an uploaded icon is served publicly, as the bytes and type that were uploaded', async t => {
  const { call, upload } = fixture(t)
  const saved = await upload('public-tool', 'image/png', PNG)
  assert.equal(saved.status, 200)
  const response = await call('/v1/icons/public-tool')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('cache-control'), /public/u)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG)
  // Replacing it changes the type and the bytes.
  await upload('public-tool', 'image/webp', WEBP)
  const replaced = await call('/v1/icons/public-tool')
  assert.equal(replaced.headers.get('content-type'), 'image/webp')
  assert.deepEqual(new Uint8Array(await replaced.arrayBuffer()), WEBP)
  assert.equal((await call('/v1/icons/no-such-tool')).status, 404)
  assert.equal((await call('/v1/icons/public-tool', { method: 'POST', data: {} })).status, 405)
})

test('only real PNG, JPEG or WebP within 256 KB is accepted', async t => {
  const { upload, call } = fixture(t)
  assert.equal((await upload('public-tool', 'image/svg+xml', new TextEncoder().encode('<svg/>'))).status, 400)
  // The declared type has to be what the bytes are.
  assert.equal((await upload('public-tool', 'image/png', WEBP)).status, 400)
  assert.equal((await upload('public-tool', 'image/jpeg', PNG)).status, 400)
  const large = new Uint8Array(256 * 1024 + 1)
  large.set(PNG)
  assert.equal((await upload('public-tool', 'image/png', large)).status, 400)
  assert.equal((await upload('no-such-tool', 'image/png', PNG)).status, 404)
  // Readers and anonymous callers cannot upload.
  assert.equal((await call('/api/v1/plugins/public-tool/icon', { key: 'sk-reader', data: { contentType: 'image/png', data: base64(PNG) } })).status, 401)
})

test('the catalog offers the icon as media.icon on its own origin, only for plugins it lists', async t => {
  const { call, upload } = fixture(t)
  await upload('public-tool', 'image/png', PNG)
  await upload('hidden-tool', 'image/png', PNG)
  const { items } = await (await call('/v1/plugins', { key: 'sk-reader' })).json()
  assert.deepEqual(items.map(item => item.id), ['public-tool'])
  const icon = items[0].media.icon
  assert.match(icon.url, /^https:\/\/market\.example\/v1\/icons\/public-tool\?v=\d+$/u)
  assert.equal(icon.alt, 'public-tool name')
  // The docs center lists the same icon beside the plugin.
  const docs = await (await call('/v1/docs', { key: 'sk-reader' })).json()
  assert.match(docs.items.find(item => item.id === 'public-tool').icon, /^\/v1\/icons\/public-tool\?v=\d+$/u)
})

test('removing an icon returns the catalog to the default glyph; changes are audited', async t => {
  const { db, call, upload } = fixture(t)
  await upload('public-tool', 'image/png', PNG)
  assert.equal((await call('/api/v1/plugins/public-tool/icon', { key: 'admin-secret', method: 'DELETE' })).status, 200)
  assert.equal((await call('/v1/icons/public-tool')).status, 404)
  const { items } = await (await call('/v1/plugins', { key: 'sk-reader' })).json()
  assert.equal(items[0].media, undefined)
  assert.equal((await call('/api/v1/plugins/public-tool/icon', { key: 'admin-secret', method: 'DELETE' })).status, 404)
  assert.deepEqual(db.prepare("SELECT action,target FROM market_audit_events WHERE action LIKE 'plugin.icon.%' ORDER BY id").all().map(row => [row.action, row.target]),
    [['plugin.icon.updated', 'public-tool'], ['plugin.icon.deleted', 'public-tool']])
})
