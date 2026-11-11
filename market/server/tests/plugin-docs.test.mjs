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
    MARKET_ORGANIZATIONS: {
      resolveIdentity: async key => IDENTITIES[key] ?? { organization: null, user: null },
      // An organization administrator signing in to the console (TokensAPI account 501, organization 1).
      resolveAccount: async credential => credential.userId === 501 ? { id: 501, displayName: 'Owner' } : null,
      resolveMyOrg: async credential => credential.userId === 501 ? { id: 1, name: 'One', role: 100 } : null,
    } }
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

test('the platform administrator\'s console session reads every plugin; an organization administrator\'s does not', async t => {
  const { env, call, addDoc } = fixture(t)
  await addDoc('org-two-tool', '内部手册')
  const session = async data => (await worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { Origin: ORIGIN },
    body: JSON.stringify(data) }), env, {})).headers.get('set-cookie').split(';')[0]
  const withCookie = (path, cookie) => worker.fetch(new Request(ORIGIN + path, { headers: { Cookie: cookie } }), env, {})

  const platform = await session({ credential: 'admin-secret' })
  const list = await (await withCookie('/v1/docs', platform)).json()
  assert.equal(list.admin, true)
  assert.deepEqual(list.items.map(item => item.id).sort(), ['org-one-tool', 'org-two-tool', 'public-tool'])
  const pages = await withCookie('/v1/docs/org-two-tool', platform)
  assert.equal(pages.status, 200)
  assert.deepEqual((await pages.json()).items.map(doc => doc.title), ['内部手册'])
  assert.equal((await withCookie('/v1/docs/no-such-tool', platform)).status, 404)
  assert.match((await withCookie('/v1/docs', platform)).headers.get('vary') ?? '', /Cookie/u)

  // An organization administrator may sign in to the console, but the docs center is not theirs to see whole.
  const tenant = await session({ tokensapi: true, accessToken: 'owner-token', userId: 501 })
  assert.equal((await withCookie('/v1/docs', tenant)).status, 401)
  // A Key decides on its own, even beside an administrator's cookie.
  const keyed = await worker.fetch(new Request(ORIGIN + '/v1/docs', { headers: { Cookie: platform, Authorization: 'Bearer sk-org-one' } }), env, {})
  const keyedList = await keyed.json()
  assert.equal(keyedList.admin, false)
  assert.ok(!keyedList.items.some(item => item.id === 'org-two-tool'))
  assert.equal((await call('/v1/docs')).status, 401)
})

test('TokensCowork opens the docs center signed in through a one-time code, never the Key in the address', async t => {
  const { call, reader } = fixture(t)
  const issued = await call('/v1/docs/codes', { key: 'sk-org-one', data: {} })
  assert.equal(issued.status, 200)
  const { code, expiresIn } = await issued.json()
  assert.match(code, /^[a-f0-9]{64}$/u)
  assert.equal(expiresIn, 60)
  assert.ok(!code.includes('sk-org-one'))

  const redeem = value => call('/v1/docs/codes/redeem', { data: { code: value } })
  const first = await redeem(code)
  assert.equal(first.status, 200)
  const { key } = await first.json()
  assert.equal(key, 'sk-org-one')
  // The redeemed Key reads exactly what the Key reads.
  assert.deepEqual((await reader(key)).map(item => item.id).sort(), ['org-one-tool', 'public-tool'])
  // Once only, and a guess is answered the same way.
  assert.equal((await redeem(code)).status, 404)
  assert.equal((await redeem('a'.repeat(64))).status, 404)
  assert.equal((await redeem('not-a-code')).status, 404)

  // A code needs a Key the market recognizes; the console session has its own way in.
  assert.equal((await call('/v1/docs/codes', { data: {} })).status, 401)
  assert.equal((await call('/v1/docs/codes', { key: 'sk-unknown', data: {} })).status, 401)
  assert.equal((await call('/v1/docs/codes', { key: 'sk-org-one' })).status, 405)
  assert.equal((await call('/v1/docs/codes/redeem', { method: 'GET' })).status, 405)
})

test('a sign-in code stops working after 60 seconds', async t => {
  const { call } = fixture(t)
  const { code } = await (await call('/v1/docs/codes', { key: 'sk-org-two', data: {} })).json()
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  Date.now = () => realNow() + 61_000
  assert.equal((await call('/v1/docs/codes/redeem', { data: { code } })).status, 404)
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

test('the documentation center lives at /docs with the console security headers', async t => {
  const { call } = fixture(t)
  for (const path of ['/docs', '/docs/']) {
    const response = await call(path)
    assert.equal(response.status, 200, path)
    assert.match(await response.text(), /<title>TokensCowork · 插件文档<\/title>/u)
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/u)
  }
  for (const path of ['/admin/assets/market-docs.js', '/admin/assets/market-docs.css', '/admin/assets/market-docs-admin.js'])
    assert.equal((await call(path)).status, 200, path)
  // One address only: the page file itself is not served under the console.
  for (const path of ['/admin/docs.html', '/docs/index.html', '/docs.html']) assert.equal((await call(path)).status, 404, path)
  assert.equal((await call('/docs', { method: 'POST', data: {} })).status, 405)
})

test('an uploaded page is titled by its first heading, else by its file name', async () => {
  const { docTitle } = await import('../admin/assets/market-docs-admin.js')
  assert.equal(docTitle('前言\n\n# 快速开始 #\n\n## 小节', 'readme.md'), '快速开始')
  assert.equal(docTitle('## 只有二级标题', '常见问题.md'), '常见问题')
  assert.equal(docTitle('正文', 'Guide.MARKDOWN'), 'Guide')
  assert.equal(docTitle('# ' + 'x'.repeat(200), 'a.md').length, 120)
})
