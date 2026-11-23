import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from '../_worker.js'
import { createAssets } from '../runtime/adapters.mjs'
import { resetTestCatalog, seedTestPlugin } from './catalog-fixture.mjs'
import { MAX_DOC_IMAGE_BYTES } from '../services/doc-images.js'
import { imageReferences, replaceImageReferences, imageFileName } from '../admin/assets/market-docs-admin.js'

// Documentation images: uploaded by the platform administrator, read only by those who may read
// the plugin's pages. Independent fixtures: no production credentials, npm or organization requests.
const ORIGIN = 'https://market.example'
const plugin = id => ({ id, package: '@example/' + id, displayName: id, summary: id + ' summary', repository: 'https://example.com/' + id, version: '1.0.0', npm: false })
const IDENTITIES = {
  'sk-org-one': { organization: { id: 1, name: 'One' }, user: { id: 101, name: 'Alice' } },
  'sk-org-two': { organization: { id: 2, name: 'Two' }, user: { id: 202, name: 'Bob' } },
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0])
const WEBP = Uint8Array.from([...'RIFF'].map(c => c.charCodeAt(0)).concat([20, 0, 0, 0], [...'WEBPVP8 '].map(c => c.charCodeAt(0)), [1, 2]))

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  resetTestCatalog(db, plugin('public-tool'))
  for (const id of ['org-one-tool', 'org-two-tool']) seedTestPlugin(db, plugin(id))
  db.exec("UPDATE market_plugins SET visibility='restricted',revision=revision+1 WHERE id IN ('org-one-tool','org-two-tool')")
  db.exec("INSERT INTO market_organizations(id,name,enabled) VALUES(1,'One',1),(2,'Two',1)")
  db.exec("INSERT INTO market_grants(plugin_id,kind,subject) VALUES('org-one-tool','org','1'),('org-two-tool','org','2')")
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values), all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const env = { MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret', MARKET_KEY_ENCRYPTION_SECRET: 'test-encryption-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } },
    ASSETS: createAssets(resolve(fileURLToPath(new URL('..', import.meta.url)))),
    MARKET_ORGANIZATIONS: { resolveIdentity: async key => IDENTITIES[key] ?? { organization: null, user: null } } }
  const call = (path, { key, cookie, body, method = 'GET', headers = {} } = {}) => worker.fetch(new Request(ORIGIN + path, { method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(cookie ? { Cookie: cookie, Origin: ORIGIN } : {}), ...headers },
    ...(body === undefined ? {} : { body }) }), env, {})
  const upload = (pluginId, bytes, name = 'shot.png', headers = {}) => call(`/api/v1/plugins/${pluginId}/docs/images?name=${encodeURIComponent(name)}`,
    { key: 'admin-secret', method: 'POST', body: bytes, headers })
  return { db, env, call, upload }
}

test('only real PNG, JPEG and WebP files up to the size limit are stored, each once', async t => {
  const { db, call, upload } = fixture(t)
  // The bytes decide, not the name or the Content-Type: text named .png is refused, a JPEG sent as image/png is a JPEG.
  const fake = await upload('public-tool', new TextEncoder().encode('<svg onload=alert(1)>'), 'evil.png', { 'content-type': 'image/png' })
  assert.deepEqual([fake.status, (await fake.json()).error], [400, '只支持 PNG、JPEG 或 WebP 图片'])
  const jpeg = await (await upload('public-tool', JPEG, 'photo.png', { 'content-type': 'image/png' })).json()
  assert.equal(jpeg.contentType, 'image/jpeg')
  assert.match(jpeg.id, /^[a-f0-9]{32}$/u)
  assert.equal(jpeg.url, `/v1/docs/public-tool/images/${jpeg.id}`)
  const png = await (await upload('public-tool', PNG, '../../images/Step 1.png')).json()
  assert.deepEqual([png.contentType, png.name, png.bytes, png.existing], ['image/png', 'Step 1.png', PNG.length, false])
  assert.equal((await (await upload('public-tool', WEBP, 'w.webp')).json()).contentType, 'image/webp')
  // The same bytes again answer with the stored image instead of a copy.
  const again = await (await upload('public-tool', PNG, 'other-name.png')).json()
  assert.deepEqual([again.id, again.existing], [png.id, true])
  // Size: exactly the limit is accepted, one byte more is refused.
  const big = new Uint8Array(MAX_DOC_IMAGE_BYTES + 1); big.set(PNG)
  const tooBig = await upload('public-tool', big)
  assert.deepEqual([tooBig.status, (await tooBig.json()).error], [400, `图片不能超过 ${MAX_DOC_IMAGE_BYTES / 1024} KB`])
  assert.equal((await upload('public-tool', big.slice(0, MAX_DOC_IMAGE_BYTES))).status, 200)
  assert.equal((await upload('public-tool', new Uint8Array())).status, 400)
  assert.equal((await upload('no-such-tool', PNG)).status, 404)
  // Listing and deleting; every change is audited; only the platform administrator may.
  const list = await (await call('/api/v1/plugins/public-tool/docs/images', { key: 'admin-secret' })).json()
  assert.equal(list.items.length, 4)
  assert.ok(list.items.every(item => !('data' in item) && item.url.startsWith('/v1/docs/public-tool/images/')))
  assert.equal((await call(`/api/v1/plugins/public-tool/docs/images/${jpeg.id}`, { key: 'admin-secret', method: 'DELETE' })).status, 200)
  assert.equal((await call(`/api/v1/plugins/public-tool/docs/images/${jpeg.id}`, { key: 'admin-secret', method: 'DELETE' })).status, 404)
  assert.equal((await call('/api/v1/plugins/public-tool/docs/images/not-an-id', { key: 'admin-secret', method: 'DELETE' })).status, 404)
  assert.equal((await call('/api/v1/plugins/public-tool/docs/images', { key: 'sk-org-one' })).status, 401)
  assert.equal((await call('/api/v1/plugins/public-tool/docs/images/x/y', { key: 'admin-secret' })).status, 404)
  const audit = db.prepare("SELECT action,target,details FROM market_audit_events WHERE action LIKE 'plugin.doc.image.%' ORDER BY id").all()
  assert.deepEqual(audit.map(row => row.action), ['plugin.doc.image.uploaded', 'plugin.doc.image.uploaded', 'plugin.doc.image.uploaded', 'plugin.doc.image.uploaded', 'plugin.doc.image.deleted'])
  assert.deepEqual(JSON.parse(audit[0].details), { bytes: JPEG.length, contentType: 'image/jpeg' })
  // Deleting the plugin takes its images with it.
  db.prepare("DELETE FROM market_plugins WHERE id='public-tool'").run()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_plugin_doc_images').get().n, 0)
})

test('an image is read exactly by those who may read the plugin\'s pages, privately cached', async t => {
  const { env, call, upload } = fixture(t)
  const image = await (await upload('org-one-tool', PNG)).json()
  const shared = await (await upload('public-tool', PNG)).json()
  const read = await call(image.url, { key: 'sk-org-one' })
  assert.equal(read.status, 200)
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), PNG)
  assert.equal(read.headers.get('content-type'), 'image/png')
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(read.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.match(read.headers.get('vary') ?? '', /Authorization/u)
  // Another organization's reader, an unknown Key and nobody: the same answers as for the pages.
  const other = await call(image.url, { key: 'sk-org-two' })
  assert.deepEqual([other.status, other.headers.get('cache-control')], [404, 'no-store'])
  assert.equal((await call(image.url, { key: 'sk-unknown' })).status, 401)
  assert.equal((await call(image.url)).status, 401)
  // An image is found under its own plugin only, and an unknown id is a 404.
  assert.equal((await call(`/v1/docs/public-tool/images/${image.id}`, { key: 'sk-org-one' })).status, 404)
  assert.equal((await call('/v1/docs/org-one-tool/images/' + 'f'.repeat(32), { key: 'sk-org-one' })).status, 404)
  assert.equal((await call('/v1/docs/org-one-tool/images/../x', { key: 'sk-org-one' })).status, 404)
  assert.equal((await call(image.url, { key: 'sk-org-one', method: 'POST' })).status, 405)
  // A public plugin's image reaches every recognized reader.
  assert.equal((await call(shared.url, { key: 'sk-org-two' })).status, 200)
  // The platform administrator's console session reads every plugin's images.
  const login = await worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { Origin: ORIGIN }, body: JSON.stringify({ credential: 'admin-secret' }) }), env, {})
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await worker.fetch(new Request(ORIGIN + image.url, { headers: { Cookie: cookie } }), env, {})).status, 200)
  // Losing the grant loses the image at once.
  env.MARKET_DB.prepare("DELETE FROM market_grants WHERE plugin_id='org-one-tool'").bind().run()
  assert.equal((await call(image.url, { key: 'sk-org-one' })).status, 404)
})

test('uploading a page with its images points each relative path at the uploaded image', () => {
  const page = [
    '# 手册', '![第一步](images/step-1.png)', '![第二步](./images/Step%202.PNG "标题")', '![外链](https://example.com/a.png)',
    '![根路径](/v1/docs/x/images/' + 'a'.repeat(32) + ')', '![漏选](images/missing.png)', '![再次](images/step-1.png)', '[不是图片](images/step-1.png)',
  ].join('\n')
  assert.deepEqual(imageReferences(page).map(ref => ref.name), ['step-1.png', 'step 2.png', 'missing.png'])
  assert.equal(imageFileName('<images/A b.webp>'), 'a b.webp')
  const uploaded = new Map([['step-1.png', '/v1/docs/p/images/' + '1'.repeat(32)], ['step 2.png', '/v1/docs/p/images/' + '2'.repeat(32)]])
  assert.equal(replaceImageReferences(page, uploaded), [
    '# 手册', `![第一步](/v1/docs/p/images/${'1'.repeat(32)})`, `![第二步](/v1/docs/p/images/${'2'.repeat(32)} "标题")`, '![外链](https://example.com/a.png)',
    '![根路径](/v1/docs/x/images/' + 'a'.repeat(32) + ')', '![漏选](images/missing.png)', `![再次](/v1/docs/p/images/${'1'.repeat(32)})`, '[不是图片](images/step-1.png)',
  ].join('\n'))
})
