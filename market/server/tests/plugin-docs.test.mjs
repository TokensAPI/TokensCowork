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
const plugin = id => ({ id, package: '@example/' + id, displayName: id, summary: id + ' summary', repository: 'https://example.com/' + id, version: '1.0.0', npm: false })
// Two TokensAPI Keys: one in organization 1, one in organization 2.
const IDENTITIES = {
  'sk-org-one': { organization: { id: 1, name: 'One' }, user: { id: 101, name: 'Alice' } },
  'sk-org-two': { organization: { id: 2, name: 'Two' }, user: { id: 202, name: 'Bob' } },
}

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
  const call = (path, { key, data, method = data === undefined ? 'GET' : 'POST' } = {}) => worker.fetch(new Request(ORIGIN + path, { method,
    headers: key ? { Authorization: `Bearer ${key}` } : {}, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
  const admin = (path, data, method) => call('/api/v1' + path, { key: 'admin-secret', data, method })
  const addDoc = async (id, title, body = `# ${title}`) => (await (await admin(`/plugins/${id}/docs`, { title, body })).json()).id
  const reader = async key => (await (await call('/v1/docs', { key })).json()).items
  return { db, env, call, admin, addDoc, reader }
}

test('a reader sees exactly the plugins their Key may use, with those plugins\' pages', async t => {
  const { call, addDoc, reader } = fixture(t)
  await addDoc('public-tool', '快速开始')
  await addDoc('org-one-tool', '使用说明')
  await addDoc('org-two-tool', '内部手册')

  const one = await reader('sk-org-one')
  assert.deepEqual(one.map(item => item.id).sort(), ['org-one-tool', 'public-tool'])
  assert.deepEqual(one.find(item => item.id === 'org-one-tool').docs.map(doc => doc.title), ['使用说明'])
  // The list carries titles only; bodies come with one plugin's pages.
  assert.equal(one.find(item => item.id === 'org-one-tool').docs[0].body, undefined)
  const pages = await (await call('/v1/docs/org-one-tool', { key: 'sk-org-one' })).json()
  assert.deepEqual(pages.items.map(doc => [doc.title, doc.body]), [['使用说明', '# 使用说明']])

  // Another organization's plugin is invisible, and asking for it looks like a plugin that does not exist.
  assert.equal((await call('/v1/docs/org-two-tool', { key: 'sk-org-one' })).status, 404)
  assert.equal((await call('/v1/docs/no-such-tool', { key: 'sk-org-one' })).status, 404)
  assert.deepEqual((await reader('sk-org-two')).map(item => item.id).sort(), ['org-two-tool', 'public-tool'])
})

test('the documentation follows grant changes without touching the pages', async t => {
  const { db, call, addDoc, reader } = fixture(t)
  await addDoc('org-two-tool', '内部手册')
  assert.ok(!(await reader('sk-org-one')).some(item => item.id === 'org-two-tool'))
  db.exec("INSERT INTO market_grants(plugin_id,kind,subject) VALUES('org-two-tool','user','101')")
  assert.ok((await reader('sk-org-one')).some(item => item.id === 'org-two-tool'))
  assert.equal((await call('/v1/docs/org-two-tool', { key: 'sk-org-one' })).status, 200)
  // The organization switch narrows what the platform offered, for the docs as for the catalog.
  db.exec("INSERT INTO market_org_hidden(organization_id,plugin_id) VALUES(2,'org-two-tool')")
  assert.equal((await call('/v1/docs/org-two-tool', { key: 'sk-org-two' })).status, 404)
})

test('signing in needs a Key the market recognizes', async t => {
  const { env, call, admin } = fixture(t)
  assert.equal((await call('/v1/docs')).status, 401)
  assert.equal((await call('/v1/docs', { key: 'sk-unknown' })).status, 401)
  assert.equal((await call('/v1/docs/public-tool', { key: 'sk-unknown' })).status, 401)
  // A Key registered in the market signs in on its own, without TokensAPI.
  await admin('/keys', { key: 'sk-registered', label: '直连' }, 'POST')
  assert.equal((await call('/v1/docs', { key: 'sk-registered' })).status, 200)
  // TokensAPI unreachable is not the reader's fault.
  env.MARKET_ORGANIZATIONS = { resolveIdentity: async () => { throw new Error('provider down') } }
  assert.equal((await call('/v1/docs', { key: 'sk-not-cached' })).status, 503)
  assert.equal((await call('/v1/docs', { key: 'sk-org-one', method: 'POST', data: {} })).status, 405)
  const response = await call('/v1/docs', { key: 'sk-registered' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('the platform administrator adds, edits and deletes pages; each change is audited', async t => {
  const { db, admin, call } = fixture(t)
  const long = '# 长文档\n\n' + '一段说明。'.repeat(10_000) // Well past the 16 KB limit of other writes.
  const created = await (await admin('/plugins/public-tool/docs', { title: '手册', body: long, position: 2 })).json()
  assert.equal(created.body, long)
  const second = await (await admin('/plugins/public-tool/docs', { title: '入门', body: '# 入门' })).json()
  assert.deepEqual((await (await admin('/plugins/public-tool/docs')).json()).items.map(doc => doc.title), ['入门', '手册'])

  const edited = await admin(`/plugins/public-tool/docs/${second.id}`, { title: '入门指南', body: '改过', position: 5 }, 'PUT')
  assert.equal(edited.status, 200)
  assert.deepEqual((await (await admin('/plugins/public-tool/docs')).json()).items.map(doc => doc.title), ['手册', '入门指南'])
  // A page is addressed through its own plugin only.
  assert.equal((await admin(`/plugins/org-one-tool/docs/${second.id}`, { title: 'x', body: 'y' }, 'PUT')).status, 404)
  assert.equal((await admin(`/plugins/public-tool/docs/${second.id}`, undefined, 'DELETE')).status, 200)
  assert.equal((await admin(`/plugins/public-tool/docs/${second.id}`, undefined, 'DELETE')).status, 404)

  for (const bad of [{ title: '', body: 'x' }, { title: 't', body: '  ' }, { title: 't', body: 'x', position: -1 }])
    assert.equal((await admin('/plugins/public-tool/docs', bad)).status, 400, JSON.stringify(bad))
  assert.equal((await admin('/plugins/no-such-tool/docs', { title: 't', body: 'x' })).status, 404)
  assert.deepEqual(db.prepare("SELECT action,target FROM market_audit_events WHERE action LIKE 'plugin.doc.%' ORDER BY id").all().map(row => [row.action, row.target]),
    [['plugin.doc.saved', `public-tool:${created.id}`], ['plugin.doc.saved', `public-tool:${second.id}`],
      ['plugin.doc.saved', `public-tool:${second.id}`], ['plugin.doc.deleted', `public-tool:${second.id}`]])
  // Readers cannot write, and a reader Key is no admin credential.
  assert.equal((await call('/api/v1/plugins/public-tool/docs', { key: 'sk-org-one', data: { title: 't', body: 'x' } })).status, 401)
})

test('the documentation center page and its assets are served', async t => {
  const { call } = fixture(t)
  for (const path of ['/admin/docs.html', '/admin/assets/market-docs.js', '/admin/assets/market-docs.css'])
    assert.equal((await call(path)).status, 200, path)
})
