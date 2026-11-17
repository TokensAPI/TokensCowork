import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from '../_worker.js'
import { createAssets } from '../runtime/adapters.mjs'

// The console's plugin page (T0079): server-side paging and filters, one icon shared by the console,
// the docs center and the desktop catalog, new plugins starting restricted, and writes kept to the
// platform administrator. Fixtures only: no production data, npm or TokensAPI requests.
const ORIGIN = 'https://market.example'
const COMPONENTS = JSON.parse(readFileSync(new URL('../product-components.json', import.meta.url), 'utf8'))
const BUILTINS = COMPONENTS.items.map(item => item.id)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const commit = 'b'.repeat(40)
const metadata = (id, fields = {}) => ({ id, category: 'optional', package: '@fixture/' + id, displayName: `Tool ${id}`, summary: `Fixture ${id}`,
  repository: 'https://github.com/fixture/' + id, version: '1.0.0', npm: false, installSource: { kind: 'github', commit }, ...fields })
// 24 market plugins in every state and scope, plus one row that duplicates a built-in component.
const STATES = ['published', 'draft', 'archived', 'published', 'deleted', 'published']
const SEED = Array.from({ length: 24 }, (_, i) => ({
  id: `tool-${String(i).padStart(2, '0')}`, state: STATES[i % STATES.length], visibility: i % 2 ? 'restricted' : 'public',
  metadata: metadata(`tool-${String(i).padStart(2, '0')}`, i === 5 ? { summary: 'Finance reports for the fixture' } : {}),
}))

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  db.exec('DELETE FROM market_plugins')
  const insert = db.prepare("INSERT INTO market_plugins(id,visibility,state,metadata,version_mode,reviewed_version) VALUES(?,?,?,?,'pinned','1.0.0')")
  for (const row of SEED) insert.run(row.id, row.visibility, row.state, JSON.stringify(row.metadata))
  insert.run('shadow', 'public', 'published', JSON.stringify(metadata('shadow', { package: COMPONENTS.items[0].package })))
  db.prepare("INSERT INTO market_organizations(id,name,enabled) VALUES(7,'Seven',1)").run()
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values),
    all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const env = {
    MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret', MARKET_KEY_ENCRYPTION_SECRET: 'test-encryption-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => {
      db.exec('BEGIN')
      try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
    } },
    ASSETS: createAssets(resolve(fileURLToPath(new URL('..', import.meta.url)))),
    MARKET_ORGANIZATIONS: {
      // sk-reader belongs to user 7 and no organization; user 501 administers organization 7.
      resolveIdentity: async key => key === 'sk-reader' ? { organization: null, user: { id: 7, name: 'Reader' } } : { organization: null, user: null },
      resolveAccount: async c => c.userId === 501 ? { id: 501, displayName: 'Owner' } : null,
      resolveMyOrg: async c => c.userId === 501 ? { id: 7, name: 'Seven', role: 100 } : null,
    },
  }
  const call = async (path, { token = 'admin-secret', cookie, data, method = data === undefined ? 'GET' : 'PUT', origin = ORIGIN } = {}) => {
    const response = await worker.fetch(new Request(ORIGIN + path, { method,
      headers: { Origin: origin, ...(token && !cookie ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, json, headers: response.headers }
  }
  const page = async query => {
    const result = await call('/api/v1/plugins?' + new URLSearchParams(query))
    assert.equal(result.status, 200, JSON.stringify(result.json))
    return result.json
  }
  const upload = (id, options = {}) => call(`/api/v1/plugins/${id}/icon`, { ...options, data: { contentType: 'image/png', data: Buffer.from(PNG).toString('base64') } })
  return { db, call, page, upload }
}

const live = SEED.filter(row => row.state !== 'deleted')
const ids = rows => rows.map(row => row.id)

test('the plugin list is paged on the server: 全部 holds the built-ins then every market plugin once, a page past the end is the last page', async t => {
  const { page, call } = fixture(t)
  const first = await page({ page: 1, pageSize: 10 })
  const everything = [...BUILTINS, ...ids(live)]
  assert.equal(first.total, everything.length)
  assert.equal(first.items.length, 10)
  assert.deepEqual([first.page, first.pageSize], [1, 10])
  // 「全部」 includes the built-in components, and the tab counts add up: 全部 = 内置 + 已上架 + 草稿 + 已下架,
  // 市场插件 = 已上架 + 草稿 + 已下架; the trash is counted on its own.
  const count = state => SEED.filter(row => row.state === state).length
  assert.deepEqual(first.counts, { all: BUILTINS.length + live.length, builtin: BUILTINS.length, market: live.length,
    published: count('published'), draft: count('draft'), archived: count('archived'), deleted: count('deleted') })
  const { counts } = first
  assert.equal(counts.all, counts.builtin + counts.published + counts.draft + counts.archived)
  assert.equal(counts.all, counts.builtin + counts.market)
  // Each tab and each type lists exactly as many rows as its count says.
  for (const stage of ['all', 'published', 'draft', 'archived', 'deleted']) assert.equal((await page({ stage })).total, counts[stage], stage)
  for (const kind of ['builtin', 'market']) assert.equal((await page({ kind })).total, counts[kind], kind)
  // Walking every page lists each row exactly once: the built-ins first in product order, then the market by id.
  const seen = []
  for (let n = 1; n <= Math.ceil(first.total / 10); n++) seen.push(...(await page({ page: n, pageSize: 10 })).items)
  assert.deepEqual(ids(seen), everything)
  assert.ok(seen.slice(0, BUILTINS.length).every(item => item.category === 'builtin' && item.state === 'builtin' && item.productVersion === COMPONENTS.productVersion))
  // The type filter splits 全部 into the components and the market's own plugins.
  assert.deepEqual(ids((await page({ kind: 'builtin' })).items), BUILTINS)
  assert.deepEqual(ids((await page({ kind: 'market', pageSize: 100 })).items), ids(live))
  // Built-ins have no lifecycle, so the other tabs never list them, whatever the type.
  for (const stage of ['published', 'draft', 'archived', 'deleted']) assert.equal((await page({ stage, kind: 'builtin' })).total, 0, stage)
  // The market row that duplicates a built-in stays hidden, as it always was on this page.
  assert.ok(!seen.some(item => item.id === 'shadow'))
  // Past the end: the last page, named in the answer.
  const last = await page({ page: 99, pageSize: 10 })
  assert.equal(last.page, Math.ceil(first.total / 10))
  assert.deepEqual(last.items.map(item => item.id), seen.slice((last.page - 1) * 10).map(item => item.id))
  assert.equal((await page({ page: 1 })).pageSize, 20)
  for (const query of ['pageSize=7', 'page=0', 'page=x', 'stage=everything', 'stage=builtin', 'kind=plugin', 'visibility=hidden', 'q=' + 'x'.repeat(101), 'view=all'])
    assert.equal((await call('/api/v1/plugins?' + query)).status, 400, query)
  // Without paging parameters the list keeps the shape TokensAPI and scripts read.
  const full = (await call('/api/v1/plugins')).json
  assert.deepEqual(Object.keys(full).sort(), ['components', 'items', 'publisher'])
  assert.equal(full.items.length, SEED.length + 1)
})

test('filters run on the server and hold across pages', async t => {
  const { page } = fixture(t)
  const drafts = await page({ stage: 'draft', pageSize: 10 })
  assert.deepEqual(ids(drafts.items), ids(SEED.filter(row => row.state === 'draft')))
  assert.deepEqual(ids((await page({ stage: 'deleted' })).items), ids(SEED.filter(row => row.state === 'deleted')))
  // Built-ins are public: the public scope lists them first, restricting the scope leaves only market plugins.
  assert.deepEqual(ids((await page({ visibility: 'public', pageSize: 100 })).items),
    [...BUILTINS, ...ids(live.filter(row => row.visibility === 'public'))])
  const restricted = await page({ visibility: 'restricted', pageSize: 10 })
  const expected = live.filter(row => row.visibility === 'restricted')
  assert.equal(restricted.total, expected.length)
  const second = await page({ visibility: 'restricted', pageSize: 10, page: 2 })
  assert.equal(second.total, expected.length)
  assert.deepEqual([...ids(restricted.items), ...ids(second.items)], ids(expected))
  const open = await page({ visibility: 'public', stage: 'published', pageSize: 100 })
  assert.deepEqual(ids(open.items), ids(live.filter(row => row.visibility === 'public' && row.state === 'published')))
  // Search covers id, name, package and summary; ASCII letters ignore case.
  assert.deepEqual(ids((await page({ q: 'FINANCE' })).items), ['tool-05'])
  assert.deepEqual(ids((await page({ q: '@fixture/tool-1' })).items), ids(live.filter(row => row.id.startsWith('tool-1'))))
  // A built-in is found under 全部 and under its own type, never among the market plugins or a lifecycle tab.
  const name = COMPONENTS.items[1].displayName
  assert.deepEqual(ids((await page({ q: name })).items), [BUILTINS[1]])
  assert.deepEqual(ids((await page({ kind: 'builtin', q: name })).items), [BUILTINS[1]])
  assert.deepEqual(ids((await page({ kind: 'market', q: name })).items), [])
  assert.deepEqual(ids((await page({ stage: 'published', q: name })).items), [])
  assert.deepEqual(ids((await page({ kind: 'builtin', visibility: 'restricted' })).items), [])
  // Counts describe the whole inventory, whatever the filters.
  assert.deepEqual(drafts.counts, (await page({ page: 1 })).counts)
})

test('one icon: the console list, the docs center and the desktop catalog name the same address', async t => {
  const { page, call, upload } = fixture(t)
  const listed = async () => (await page({ q: 'tool-00' })).items[0]
  assert.equal((await listed()).icon, null)
  assert.equal((await upload('tool-00')).status, 200)
  const icon = (await listed()).icon
  assert.match(icon, /^\/v1\/icons\/tool-00\?v=\d+$/u)
  assert.equal((await call('/api/v1/plugins/tool-00')).json.icon, icon)
  assert.equal((await call('/api/v1/plugins')).json.items.find(item => item.id === 'tool-00').icon, icon)
  assert.equal((await call('/api/v1/plugins?view=index')).json.items.find(item => item.id === 'tool-00').icon, undefined)
  // The docs center and the catalog the desktop market reads point at the very same image and version.
  const docs = (await call('/v1/docs', { token: 'sk-reader' })).json.items.find(item => item.id === 'tool-00')
  assert.equal(docs.icon, icon)
  const catalog = (await call('/v1/plugins', { token: 'sk-reader' })).json.items.find(item => item.id === 'tool-00')
  assert.equal(catalog.media.icon.url, ORIGIN + icon)
  const served = await call(icon)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'image/png')
  // Removing it clears all three.
  assert.equal((await call('/api/v1/plugins/tool-00/icon', { method: 'DELETE' })).status, 200)
  assert.equal((await listed()).icon, null)
  assert.equal((await call('/v1/docs', { token: 'sk-reader' })).json.items.find(item => item.id === 'tool-00').icon, undefined)
  assert.equal((await call('/v1/plugins', { token: 'sk-reader' })).json.items.find(item => item.id === 'tool-00').media, undefined)
})

test('a new plugin starts restricted; plugins already listed keep their scope', async t => {
  const { db, call } = fixture(t)
  const before = db.prepare('SELECT id,visibility,state,revision FROM market_plugins ORDER BY id').all()
  const created = await call('/api/v1/plugins', { method: 'POST', data: { id: 'fresh-tool', metadata: metadata('fresh-tool') } })
  assert.deepEqual(created.json, { ok: true, state: 'draft', revision: 1 })
  assert.equal(db.prepare("SELECT visibility FROM market_plugins WHERE id='fresh-tool'").get().visibility, 'restricted')
  assert.deepEqual(JSON.parse(db.prepare("SELECT details FROM market_audit_events WHERE action='catalog.created'").get().details),
    { state: 'draft', visibility: 'restricted' })
  // No migration: every plugin that was already there is exactly as it was.
  assert.deepEqual(db.prepare("SELECT id,visibility,state,revision FROM market_plugins WHERE id!='fresh-tool' ORDER BY id").all(), before)
  // Restricted needs no public confirmation to publish, and then shows to nobody until it is granted.
  assert.equal((await call('/api/v1/plugins/fresh-tool/publish', { method: 'POST', data: { revision: 1 } })).status, 200)
  const visible = async () => (await call('/v1/plugins', { token: 'sk-reader' })).json.items.map(item => item.id)
  assert.ok(!(await visible()).includes('fresh-tool'))
  assert.equal((await call('/api/v1/users/7', { data: { name: 'Reader' } })).status, 200)
  assert.equal((await call('/api/v1/plugins/fresh-tool/access', { data: { visibility: 'restricted', users: [7], revision: 2 } })).status, 200)
  assert.ok((await visible()).includes('fresh-tool'))
  const indexed = (await call('/api/v1/plugins?view=index')).json.items.find(item => item.id === 'fresh-tool')
  assert.deepEqual(indexed, { id: 'fresh-tool', displayName: 'Tool fresh-tool', package: '@fixture/fresh-tool', state: 'published', visibility: 'restricted' })
})

test('only the platform administrator lists plugins or changes an icon or a plugin', async t => {
  const { db, call, upload } = fixture(t)
  const tenant = (await call('/api/v1/session', { token: null, data: { tokensapi: true, accessToken: 'owner', userId: 501 } })).headers.get('set-cookie').split(';')[0]
  const platform = (await call('/api/v1/session', { token: null, data: { credential: 'admin-secret' } })).headers.get('set-cookie').split(';')[0]
  const audit = () => db.prepare('SELECT COUNT(*) AS n FROM market_audit_events').get().n
  const writes = audit()
  // An organization administrator is signed in, but not for these.
  for (const path of ['/api/v1/plugins?page=1', '/api/v1/plugins?view=index']) assert.equal((await call(path, { cookie: tenant })).status, 403, path)
  assert.equal((await upload('tool-00', { cookie: tenant })).status, 403)
  assert.equal((await call('/api/v1/plugins/tool-00/icon', { cookie: tenant, method: 'DELETE' })).status, 403)
  assert.equal((await call('/api/v1/plugins', { cookie: tenant, method: 'POST', data: { id: 'sneaky', metadata: metadata('sneaky') } })).status, 403)
  // No credential, a reader's Key, or the admin's own cookie from another site: refused as well.
  assert.equal((await upload('tool-00', { token: null })).status, 401)
  assert.equal((await call('/api/v1/plugins?page=1', { token: null })).status, 401)
  assert.equal((await upload('tool-00', { token: 'sk-reader' })).status, 401)
  assert.equal((await upload('tool-00', { cookie: platform, origin: 'https://elsewhere.example' })).status, 403)
  assert.equal((await call('/api/v1/plugins', { cookie: platform, origin: 'https://elsewhere.example', method: 'POST', data: { id: 'sneaky', metadata: metadata('sneaky') } })).status, 403)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_plugin_icons').get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_plugins WHERE id='sneaky'").get().n, 0)
  assert.equal(audit(), writes)
  // The same cookie from the console's own origin works.
  assert.equal((await upload('tool-00', { cookie: platform })).status, 200)
})
