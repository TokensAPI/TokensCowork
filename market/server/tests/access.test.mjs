import { resetTestCatalog, seedTestPlugin } from './catalog-fixture.mjs'
import { buildProductComponents } from '../../../scripts/generate-market-catalog.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from '../_worker.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { createAssets } from '../runtime/adapters.mjs'

// Independent fixtures: no production credentials, npm or organization requests.
const metadata = { id: 'private-tool', package: '@example/tool', displayName: '工具', summary: '企业工具', repository: 'https://example.com/repo', version: '1.0.0', npm: false }
const ORIGIN = 'https://market.example'
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  resetTestCatalog(db, metadata)
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values), all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const env = { MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret', MARKET_KEY_ENCRYPTION_SECRET: 'test-encryption-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } },
    ASSETS: createAssets(resolve(fileURLToPath(new URL('..', import.meta.url)))) }
  const call = (path, key, data, headers = {}, method = data === undefined ? 'GET' : 'PUT') => worker.fetch(new Request(ORIGIN + path, { method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
  const admin = (path, data, method) => call('/api/v1' + path, 'admin-secret', data, {}, method)
  const revision = (id = metadata.id) => db.prepare('SELECT revision FROM market_plugins WHERE id=?').get(id)?.revision
  const access = (data = {}, id = metadata.id) => admin(`/plugins/${id}/access`, { visibility: 'restricted', organizations: [], keys: [], revision: revision(id), ...data })
  const key = async (raw, label = '企业 A') => (await (await admin('/keys', { key: raw, label }, 'POST')).json()).fingerprint
  const organization = (id, enabled = true) => admin('/organizations/' + id, { name: 'Org ' + id, enabled })
  const visible = async (key, path = '/roster.json') => (await (await call(path, key)).json()).items.map(item => item.id)
  return { db, env, call, admin, revision, access, key, organization, visible }
}

test('admin pages and public assets are served; source files and old routes are not', async t => {
  const { call } = fixture(t)
  for (const path of ['/admin/', '/admin/index.html', '/admin/access.html', '/admin/assets/market-admin.js', '/admin/assets/market-api.js', '/admin/assets/market-model.js', '/admin/assets/market-admin.css', '/source.json'])
    assert.equal((await call(path)).status, 200, path)
  for (const path of ['/admin/organization-ui.js', '/admin/assets/unknown.js', '/%73erver/services/auth.js', '/scripts/schema.sql', '/tests/access.test.mjs', '/%73cripts/schema.sql',
    '/server/market-worker.js', '/server/security/key-vault.js', '/database/migrations/001-market-access.sql', '/ops/market-copy-admin-token.ps1',
    '/legacy/admin/market-access.js', '/roster-not-public.json', '/package.json', '/README.md', '/source.config.json', '/downloads/private-tool'])
    assert.equal((await call(path)).status, 404, path)
  for (const path of ['/api/admin/access', '/api/admin/login', '/api/admin/catalog']) assert.equal((await call(path, 'admin-secret')).status, 404, path)
})

test('session persists across requests, blocks CSRF and is revoked on logout', async t => {
  const { env, db } = fixture(t)
  const call = (path, method = 'GET', cookie = '', origin = ORIGIN, data) => worker.fetch(new Request(ORIGIN + '/api/v1/' + path, { method,
    headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
  assert.equal((await call('session', 'PUT', '', 'https://evil.example', { credential: 'admin-secret' })).status, 403)
  assert.equal((await call('session', 'PUT', '', ORIGIN, { credential: 'wrong' })).status, 401)
  const login = await call('session', 'PUT', '', ORIGIN, { credential: 'admin-secret' })
  assert.equal(login.status, 200)
  const header = login.headers.get('set-cookie'), cookie = header.split(';')[0]
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=604800']) assert.ok(header.includes(flag))
  assert.ok(!header.includes('admin-secret'))
  assert.notEqual(db.prepare('SELECT token_hash FROM market_sessions').get().token_hash, cookie.split('=')[1])
  for (let i = 0; i < 2; i++) assert.equal((await call('organizations', 'GET', cookie)).status, 200)
  assert.equal((await (await call('session', 'GET', cookie)).json()).role, 'platform')
  for (const origin of ['https://evil.example', ''])
    assert.equal((await call('organizations/1', 'PUT', cookie, origin, { name: 'Org', enabled: true })).status, 403)
  assert.equal((await call('organizations/1', 'PUT', cookie, ORIGIN, { name: 'Org', enabled: true })).status, 200)
  const logout = await call('session', 'DELETE', cookie)
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'))
  assert.equal((await call('organizations', 'GET', cookie)).status, 401)
})

test('expired and credential-rotated sessions fail closed', async t => {
  const { env, db } = fixture(t)
  const login = () => worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { Origin: ORIGIN }, body: JSON.stringify({ credential: env.MARKET_ADMIN_TOKEN }) }), env, {})
  const check = cookie => worker.fetch(new Request(ORIGIN + '/api/v1/plugins', { headers: { Cookie: cookie } }), env, {})
  let cookie = (await login()).headers.get('set-cookie').split(';')[0]
  assert.equal((await check(cookie)).status, 200)
  db.exec('UPDATE market_sessions SET expires_at=0')
  assert.equal((await check(cookie)).status, 401)
  cookie = (await login()).headers.get('set-cookie').split(';')[0]
  env.MARKET_ADMIN_TOKEN = 'new-password'
  assert.equal((await check(cookie)).status, 401)
  assert.equal((await check('__Host-market_session=' + 'a'.repeat(64))).status, 401)
})

test('admin endpoints reject missing, wrong and customer credentials', async t => {
  const { call } = fixture(t)
  for (const path of ['/api/v1/plugins', '/api/v1/keys', '/api/v1/organizations', '/api/v1/audit'])
    assert.equal((await call(path)).status, 401, path)
  for (const key of ['wrong-password', 'sk-customer-a']) assert.equal((await call('/api/v1/plugins', key)).status, 401, key)
})

test('a legacy market row duplicating a built-in package is not installable', async t => {
  const { db, admin, call, visible } = fixture(t)
  const duplicate = { ...metadata, id: 'legacy-login', package: '@tokensapi/dsh-login', npm: true, registry: 'tokenscowork' }
  seedTestPlugin(db, duplicate)
  // The raw admin API retains the historical row; the console view hides it.
  const raw = await (await admin('/plugins')).json()
  assert.ok(raw.items.some(item => item.id === duplicate.id))
  assert.ok(raw.components.items.some(item => item.package === duplicate.package))
  for (const path of ['/roster.json', '/v1/plugins'])
    assert.ok(!await visible(undefined, path).then(ids => ids.includes(duplicate.id)), path)
  const metadataResponse = await call('/registry/by-package/%40tokensapi%2Fdsh-login')
  assert.equal(metadataResponse.status, 403)
  const tarballResponse = await call('/registry/legacy-login/%40tokensapi%2Fdsh-login/0.1.5/tarball')
  assert.equal(tarballResponse.status, 403)
  assert.ok((await visible()).includes(metadata.id), 'unrelated market plugins remain visible')
})

test('a restricted plugin is listed only to a granted Key, and raw Keys stay sealed', async t => {
  const { call, admin, access, key, db, visible } = fixture(t)
  const fp = await key('sk-customer-a')
  assert.equal(fp.length, 64)
  assert.equal((await access({ keys: [fp] })).status, 200)
  for (const raw of [undefined, 'sk-other', 'sk-customer-a']) {
    for (const path of ['/v1/plugins', '/v1/plugins/', '/roster.json']) {
      const response = await call(path, raw)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal((await response.json()).items.length, raw === 'sk-customer-a' ? 1 : 0, `${raw} ${path}`)
    }
  }
  // The raw value is read back only from the Key directory, never from plugins or the log.
  for (const path of ['/plugins', '/plugins/' + metadata.id, '/audit'])
    assert.ok(!(await (await admin(path)).text()).includes('sk-customer-a'), path)
  assert.equal((await (await admin('/keys')).json()).items[0].apiKey, 'sk-customer-a')
  assert.equal((await (await admin('/keys/' + fp)).json()).apiKey, 'sk-customer-a')
  assert.ok(!db.prepare('SELECT encrypted_value FROM market_keys').get().encrypted_value.includes('sk-customer-a'))
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM market_audit_events').all()).includes('sk-customer-a'))
  // Deleting the Key takes its grants with it.
  assert.equal((await admin('/keys/' + fp, undefined, 'DELETE')).status, 200)
  assert.deepEqual(await visible('sk-customer-a'), [])
  assert.equal(db.prepare("SELECT count(*) AS n FROM market_grants WHERE kind='key'").get().n, 0)
})

test('organization OR Key grants allow access and revoke independently', async t => {
  const { env, access, key, organization, visible, admin, db, revision } = fixture(t)
  for (const id of [1, 2]) assert.equal((await organization(id)).status, 200)
  let lookups = 0
  env.MARKET_ORGANIZATIONS = { resolveOrganization: async raw => { lookups++; return ['sk-first', 'sk-second'].includes(raw) ? { id: 1, name: 'Org' } : raw === 'sk-other' ? { id: 2, name: 'Org' } : null } }
  const fp = await key('sk-direct')
  assert.equal((await access({ organizations: [1], keys: [fp] })).status, 200)
  for (const raw of [undefined, 'sk-first', 'sk-second', 'sk-other', 'sk-revoked', 'sk-direct'])
    assert.equal((await visible(raw)).length, ['sk-first', 'sk-second', 'sk-direct'].includes(raw) ? 1 : 0, raw)
  // A client-supplied organization never overrides the provider.
  assert.deepEqual(await visible('sk-other', '/roster.json?organizationId=1'), [])
  // Several restricted plugins still cost one identity lookup per catalog request.
  seedTestPlugin(db, { ...metadata, id: 'another-tool' })
  assert.equal((await access({ organizations: [1] }, 'another-tool')).status, 200)
  lookups = 0; await visible('sk-first'); assert.equal(lookups, 1)
  // Dropping the organization leaves the Key grant, and the reverse.
  assert.equal((await access({ keys: [fp] })).status, 200)
  assert.deepEqual(await visible('sk-first'), ['another-tool'])
  assert.deepEqual(await visible('sk-direct'), [metadata.id])
  assert.equal((await access({ organizations: [1] })).status, 200)
  assert.deepEqual(await visible('sk-direct'), [])
  assert.deepEqual((await visible('sk-first')).sort(), ['another-tool', metadata.id])
  // Disabling the organization revokes everything it was granted.
  assert.equal((await organization(1, false)).status, 200)
  assert.deepEqual(await visible('sk-first'), [])
  // Clearing every grant leaves the plugin restricted; opening it is its own decision.
  assert.equal((await access()).status, 200)
  assert.equal(db.prepare('SELECT visibility FROM market_plugins WHERE id=?').get(metadata.id).visibility, 'restricted')
  assert.deepEqual(await visible(), [])
  assert.equal((await access({ visibility: 'public' })).status, 200)
  assert.deepEqual(await visible(), [metadata.id])
  assert.equal((await admin(`/plugins/${metadata.id}/access`, { visibility: 'public', organizations: [], keys: [], revision: revision() - 1 })).status, 409)
})

test('a user grant follows the Key owner; per-subject grant lists replace and bump revisions', async t => {
  const { env, access, key, organization, visible, admin, db, revision } = fixture(t)
  await organization(1)
  seedTestPlugin(db, { ...metadata, id: 'another-tool' })
  assert.equal((await access({}, 'another-tool')).status, 200)
  let lookups = 0
  const owners = { 'sk-alice': 102, 'sk-alice-2': 102, 'sk-bob': 103 }
  env.MARKET_ORGANIZATIONS = { resolveIdentity: async raw => { lookups++
    return { organization: raw === 'sk-bob' ? { id: 1, name: 'Org 1' } : null, user: owners[raw] ? { id: owners[raw], name: 'U' } : null } } }
  // A user must be in the directory before it can be granted anything.
  assert.equal((await access({ users: [102] })).status, 400)
  assert.equal((await admin('/users/102', { name: '' })).status, 400)
  assert.equal((await admin('/users/102', { name: 'Alice' })).status, 200)
  assert.equal((await admin('/users/102/grants')).status, 200)
  assert.equal((await admin('/users/999/grants')).status, 404)
  assert.equal((await access({ users: [102] })).status, 200)
  assert.deepEqual((await (await admin(`/plugins/${metadata.id}`)).json()).access, { organizations: [], keys: [], users: [102] })
  // Every Key the user owns sees it, whatever organization it belongs to; nobody else does.
  assert.deepEqual(await visible('sk-alice'), [metadata.id])
  assert.deepEqual(await visible('sk-alice-2'), [metadata.id])
  assert.deepEqual(await visible('sk-bob'), [])
  assert.deepEqual(await visible(), [])
  lookups = 0; await visible('sk-alice'); assert.equal(lookups, 1)
  // The same grants edited from the subject's side: a full replace, with a revision step per change.
  const before = { a: revision(), b: revision('another-tool') }
  assert.equal((await admin('/users/102/grants', { plugins: ['another-tool', 'missing'] })).status, 400)
  assert.equal((await admin('/users/102/grants', { plugins: ['another-tool'] })).status, 200)
  assert.deepEqual(await visible('sk-alice'), ['another-tool'])
  assert.deepEqual([revision(), revision('another-tool')], [before.a + 1, before.b + 1])
  assert.deepEqual((await (await admin('/users/102/grants')).json()).plugins, ['another-tool'])
  assert.equal((await admin('/organizations/1/grants', { plugins: [metadata.id] })).status, 200)
  assert.deepEqual(await visible('sk-bob'), [metadata.id])
  const fp = await key('sk-direct')
  assert.equal((await admin(`/keys/${fp}/grants`, { plugins: [metadata.id, 'another-tool'] })).status, 200)
  assert.deepEqual((await visible('sk-direct')).sort(), ['another-tool', metadata.id])
  assert.deepEqual((await (await admin('/users')).json()).items, [{ id: 102, name: 'Alice', createdAt: db.prepare('SELECT created_at FROM market_users').get().created_at, plugins: ['another-tool'] }])
  // Removing the user takes its grants with it.
  assert.equal((await admin('/users/102', undefined, 'DELETE')).status, 200)
  assert.deepEqual(await visible('sk-alice'), [])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_grants WHERE kind='user'").get().n, 0)
  // Search needs TokensAPI; without it the console falls back to manual entry.
  assert.equal((await (await admin('/users')).json()).searchReady, false)
  assert.equal((await admin('/users/search?keyword=al')).status, 503)
  env.MARKET_ORGANIZATIONS.searchUsers = async () => ({ items: [{ id: 102, name: 'Alice', username: 'alice' }], total: 1 })
  assert.deepEqual(await (await admin('/users/search?keyword=al')).json(), { items: [{ id: 102, name: 'Alice', username: 'alice' }], total: 1 })
  assert.equal((await admin('/users/search?keyword=')).status, 400)
})

test('a Key grant stands apart from its organization, the organization switch and user grants', async t => {
  const { env, access, key, organization, visible, admin } = fixture(t)
  await organization(1)
  // Both Keys belong to the same member of organization 1.
  env.MARKET_ORGANIZATIONS = { resolveIdentity: async () => ({ organization: { id: 1, name: 'Org' }, user: { id: 102, name: 'U' } }) }
  assert.equal((await admin('/users/102', { name: 'Alice' })).status, 200)
  const fp = await key('sk-member-direct')
  assert.equal((await access({ organizations: [1], keys: [fp], users: [102] })).status, 200)
  assert.deepEqual(await visible('sk-member-direct'), [metadata.id])
  assert.deepEqual(await visible('sk-member-plain'), [metadata.id])
  // The organization switches the plugin off and is then disabled; the user grant is withdrawn.
  assert.equal((await admin(`/organizations/1/plugins/${metadata.id}`, { enabled: false })).status, 200)
  assert.equal((await organization(1, false)).status, 200)
  assert.equal((await access({ organizations: [1], keys: [fp] })).status, 200)
  // Only the Key grant is left, and it reaches exactly that Key.
  assert.deepEqual(await visible('sk-member-direct'), [metadata.id])
  assert.deepEqual(await visible('sk-member-plain'), [])
  assert.equal((await admin(`/keys/${fp}/grants`, { plugins: [] })).status, 200)
  assert.deepEqual(await visible('sk-member-direct'), [])
})

test('a direct Key survives an unavailable organization provider; others fail closed', async t => {
  const { env, access, key, organization, visible, call, db } = fixture(t)
  await organization(1)
  assert.equal((await access({ keys: [await key('sk-direct')] })).status, 200)
  seedTestPlugin(db, { ...metadata, id: 'org-only' })
  assert.equal((await access({ organizations: [1] }, 'org-only')).status, 200)
  env.MARKET_ORGANIZATIONS = { resolveOrganization: async () => { throw new Error('provider down') } }
  assert.deepEqual(await visible('sk-direct'), [metadata.id])
  assert.equal((await call('/roster.json', 'sk-nothing')).status, 503)
  env.MARKET_ORGANIZATIONS = { resolveOrganization: async () => ({ id: 'not-a-number', name: 'Bad' }) }
  assert.equal((await call('/roster.json', 'sk-nothing')).status, 503)
})

test('database errors and a missing binding never fall back to a static catalog', async t => {
  const { env, call } = fixture(t)
  const prepare = env.MARKET_DB.prepare
  env.MARKET_DB.prepare = () => { throw new Error('database unavailable') }
  for (const path of ['/v1/plugins', '/roster.json']) assert.equal((await call(path)).status, 503, path)
  env.MARKET_DB.prepare = prepare
  env.MARKET_ACCESS_REQUIRED = 'true'; delete env.MARKET_DB
  for (const path of ['/v1/plugins', '/roster.json', '/api/v1/plugins']) assert.equal((await call(path, 'admin-secret')).status, 503, path)
})

test('organization administration rejects invalid input; sync is admin-only and atomic', async t => {
  const { admin, access, call, env, db } = fixture(t)
  for (const id of ['0', '-1', '1.1', 'abc', '9007199254740992']) assert.equal((await admin('/organizations/' + id, { name: 'Org', enabled: true })).status, 400, id)
  for (const body of [{ name: '', enabled: true }, { name: 'Org', enabled: 1 }, { name: 'x'.repeat(201), enabled: true }])
    assert.equal((await admin('/organizations/1', body)).status, 400, JSON.stringify(body))
  assert.equal((await call('/api/v1/organizations/1', 'sk-customer', { name: 'Org', enabled: true })).status, 401)
  assert.equal((await admin('/organizations/1')).status, 404)
  assert.equal((await admin('/organizations/1/plugins/test-tool/extra', { enabled: false })).status, 404)
  assert.equal((await access({ organizations: [999] })).status, 400)
  assert.equal((await call('/api/v1/organizations/sync', 'sk-customer', {}, {}, 'POST')).status, 401)
  assert.equal((await admin('/organizations/sync', {}, 'POST')).status, 503)
  await admin('/organizations/1', { name: 'Old', enabled: false })
  env.MARKET_ORGANIZATIONS = { listOrganizations: async () => [{ id: 1, name: 'New' }, { id: 2, name: 'Second' }] }
  assert.equal((await admin('/organizations/sync', {}, 'POST')).status, 200)
  assert.deepEqual(db.prepare('SELECT id,name,enabled FROM market_organizations ORDER BY id').all().map(o => ({ ...o })),
    [{ id: 1, name: 'New', enabled: 0 }, { id: 2, name: 'Second', enabled: 1 }])
  env.MARKET_ORGANIZATIONS.listOrganizations = async () => [{ id: 3, name: 'Third' }, { id: 2, name: 123 }]
  assert.equal((await admin('/organizations/sync', {}, 'POST')).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_organizations').get().n, 2)
})

test('cookie writes from another origin and oversized JSON are rejected', async t => {
  const { env } = fixture(t)
  const login = await worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { Origin: ORIGIN }, body: JSON.stringify({ credential: 'admin-secret' }) }), env, {})
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const request = (headers, body) => worker.fetch(new Request(ORIGIN + '/api/v1/keys', { method: 'POST', headers, body }), env, {})
  assert.equal((await request({ Cookie: cookie, Origin: 'https://attacker.example' }, '{}')).status, 403)
  assert.equal((await request({ Authorization: 'Bearer admin-secret' }, ' '.repeat(17000))).status, 400)
})

test('HMAC fingerprint depends on server secret', async () => {
  assert.notEqual(await fingerprint('sk-test', 'one'), await fingerprint('sk-test', 'two'))
})

test('product component identities are derived directly from product.json', () => {
  const product = JSON.parse(readFileSync(new URL('../../../product.json', import.meta.url), 'utf8'))
  assert.deepEqual(buildProductComponents(product).items.map(p => p.id).sort(), product.plugins.filter(p => p.enabledByDefault && p.patch).map(p => p.id).sort())
})

// An organization administrator signs in with a TokensAPI account and is narrowed to its own
// organization's plugin switches. Everyone else is refused at the door.
test('organization administrators sign in with TokensAPI and manage only their own switches', async t => {
  const { env, db, access, organization, visible } = fixture(t)
  await organization(7); await organization(8); await organization(9, false)
  const people = {
    owner: { id: 501, org: { id: 7, name: 'Org 7', role: 100 } },
    member: { id: 502, org: { id: 7, name: 'Org 7', role: 1 } },
    loner: { id: 503, org: null },
    stranger: { id: 504, org: { id: 99, name: 'Unregistered', role: 100 } },
    disabled: { id: 505, org: { id: 9, name: 'Org 9', role: 100 } },
  }
  const person = c => people[c.accessToken]?.id === c.userId ? people[c.accessToken] : null
  env.MARKET_ORGANIZATIONS = {
    resolveAccount: async c => person(c) && { id: person(c).id, displayName: c.accessToken },
    resolveMyOrg: async c => person(c)?.org ?? null,
    resolveOrganization: async raw => raw === 'sk-seven' ? { id: 7, name: 'Org 7' } : null,
  }
  assert.equal((await access({ organizations: [7, 8] })).status, 200)
  const login = (accessToken, userId) => worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { Origin: ORIGIN },
    body: JSON.stringify({ tokensapi: true, accessToken, userId }) }), env, {})
  for (const [name, userId] of [['owner', 999], ['member', 502], ['loner', 503], ['stranger', 504], ['disabled', 505]])
    assert.equal((await login(name, userId)).status, 401, name)
  const response = await login('owner', 501)
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie').split(';')[0]
  const call = (path, data) => worker.fetch(new Request(ORIGIN + '/api/v1' + path, { method: data === undefined ? 'GET' : 'PUT',
    headers: { Cookie: cookie, Origin: ORIGIN }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
  const seat = await (await call('/session')).json()
  assert.deepEqual([seat.role, seat.organizationId, seat.userId, seat.environment], ['organization', 7, '501', undefined])
  assert.equal((await (await call('/organizations/7')).json()).name, 'Org 7')
  const offered = (await (await call('/organizations/7/plugins')).json()).items
  assert.deepEqual(offered.map(p => [p.id, p.source, p.enabled, p.visible]), [[metadata.id, 'organization', true, true]])
  assert.deepEqual(await visible('sk-seven'), [metadata.id])
  assert.equal((await call(`/organizations/7/plugins/${metadata.id}`, { enabled: false })).status, 200)
  assert.deepEqual(await visible('sk-seven'), [])
  assert.equal(db.prepare('SELECT count(*) AS n FROM market_org_hidden WHERE organization_id=7').get().n, 1)
  for (const path of ['/organizations/8', '/organizations/8/plugins', '/organizations', '/plugins', '/keys', '/audit'])
    assert.equal((await call(path)).status, 403, path)
  assert.equal((await call(`/organizations/8/plugins/${metadata.id}`, { enabled: false })).status, 403)
  assert.equal((await call('/organizations/7', { name: 'Renamed', enabled: true })).status, 403)
  assert.equal((await call(`/organizations/7/plugins/${metadata.id}`, { enabled: true })).status, 200)
  assert.deepEqual(await visible('sk-seven'), [metadata.id])
  // Disabling the organization ends the session.
  assert.equal((await organization(7, false)).status, 200)
  assert.equal((await call('/session').then(r => r.json())).authenticated, false)
})

// The Registry is storage only: it holds public and restricted plugins side by
// side, and the admin backend's visibility switch alone decides who may see and
// install each one. The proxy always speaks to the Registry as the service
// account, so even a scope the Registry itself gates behind login distributes
// normally once the backend makes the entry public.
const selfHostedEnv = { MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example.test/', MARKET_PRIVATE_REGISTRY_TOKEN: 'market:s3cret', MARKET_PRIVATE_REGISTRY_AUTH_SCHEME: 'basic' }
const selfHosted = { id: 'self-hosted-tool', package: '@fixture/self-hosted', displayName: '自建源插件', summary: '放在自建 Registry 的公开插件', repository: 'https://github.com/fixture/self-hosted', version: '1.0.0', npm: true, registry: 'tokenscowork' }
const serviceBasic = 'Basic ' + btoa('market:s3cret')
function grantKey(db, pluginId, fp) {
  db.prepare("UPDATE market_plugins SET visibility='restricted',revision=revision+1 WHERE id=?").run(pluginId)
  db.prepare("INSERT INTO market_keys(fingerprint,label) VALUES(?,'fixture') ON CONFLICT DO NOTHING").run(fp)
  db.prepare("INSERT INTO market_grants(plugin_id,kind,subject) VALUES(?,'key',?)").run(pluginId, fp)
}
function selfHostedMetadata(name, tarball) {
  return Response.json({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0', dist: { tarball } } } })
}

test('compatible entries resolve different versions for modern and legacy clients and preserve grants', async t => {
  const { env, call, admin, db } = fixture(t)
  Object.assign(env, selfHostedEnv)
  const entry = { ...selfHosted, registry: 'npm' }
  seedTestPlugin(db, entry)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname !== 'registry.example.test') return Response.json({ latest: '1.0.0' })
    assert.equal(options.headers.Authorization, serviceBasic)
    if (String(url).endsWith('.tgz')) return new Response('new-tarball')
    return Response.json({ name: entry.package, 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { name: entry.package, version: '2.0.0', dist: { tarball: 'https://registry.example.test/pkg.tgz' } } } })
  })
  const capability = { 'X-Dsh-Catalog-Registries': 'tokenscowork' }
  const listing = async headers => (await (await call('/v1/plugins', undefined, undefined, headers)).json()).items.find(x => x.id === entry.id)
  assert.equal((await listing({})).latestVersion, '1.0.0')
  assert.equal((await listing({})).package.registry, 'npm')
  assert.equal((await listing(capability)).latestVersion, '2.0.0')
  assert.equal((await listing(capability)).package.registry, 'tokenscowork')
  const listed = (await (await admin('/plugins')).json()).items.find(x => x.id === entry.id)
  assert.equal(listed.registry, 'npm')
  assert.equal(listed.effectiveRegistry, 'tokenscowork')
  assert.equal(listed.npmLatestVersion, '2.0.0')
  const download = '/registry/' + entry.id + '/' + entry.package + '/2.0.0/tarball'
  assert.equal((await call(download)).status, 200)
  const fp = await fingerprint('sk-compatible', env.MARKET_HMAC_SECRET)
  grantKey(db, entry.id, fp)
  assert.equal(await listing({}), undefined)
  assert.equal(await listing(capability), undefined)
  assert.equal((await call(download)).status, 403)
  assert.equal((await call(download, 'sk-compatible')).status, 200)
  assert.equal((await call('/registry/wrong-id/' + entry.package)).status, 403)
})

test('a public self-hosted plugin is served to everyone; restricting it closes the proxy', async t => {
  const { env, call, db } = fixture(t)
  Object.assign(env, selfHostedEnv)
  seedTestPlugin(db, selfHosted)
  const credentials = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    credentials.push(options.headers.Authorization)
    return String(url).endsWith('.tgz')
      ? new Response('tarball-bytes', { headers: { 'content-type': 'application/octet-stream' } })
      : selfHostedMetadata(selfHosted.package, 'https://registry.example.test/self-hosted-1.0.0.tgz')
  })
  const path = '/registry/self-hosted-tool/' + selfHosted.package
  const sharedPath = '/registry/by-package/' + encodeURIComponent(selfHosted.package)
  const capability = { 'X-Dsh-Catalog-Registries': 'npm tokenscowork' }
  assert.ok((await (await call('/v1/plugins', undefined, undefined, capability)).json()).items.some(item => item.id === selfHosted.id))
  // Clients that do not declare self-hosted support (desktop builds before
  // 0.4.11 whose schema rejects any non-npm registry) keep the old payload.
  const legacy = (await (await call('/v1/plugins')).json()).items
  assert.equal(legacy.some(item => item.id === selfHosted.id), false)
  assert.ok(legacy.every(item => item.package === undefined || item.package.registry === 'npm'))
  credentials.length = 0
  assert.equal((await call(path)).status, 200)
  assert.equal((await call(sharedPath)).status, 200)
  assert.deepEqual(credentials, [serviceBasic, serviceBasic])
  credentials.length = 0
  assert.equal((await call(path + '/1.0.0/tarball')).status, 200)
  assert.deepEqual(credentials, [serviceBasic, serviceBasic])

  const fp = await fingerprint('sk-self-hosted', env.MARKET_HMAC_SECRET)
  grantKey(db, selfHosted.id, fp)
  assert.equal((await call(path)).status, 403)
  assert.equal((await call(sharedPath)).status, 403)
  assert.equal((await (await call('/v1/plugins', undefined, undefined, capability)).json()).items.some(item => item.id === selfHosted.id), false)
  credentials.length = 0
  assert.equal((await call(path, 'sk-self-hosted')).status, 200)
  assert.equal((await call(sharedPath, 'sk-self-hosted')).status, 200)
  assert.deepEqual(credentials, [serviceBasic, serviceBasic])
})

test('a package the Registry gates behind login still distributes once the backend makes it public', async t => {
  const { env, call, admin, access, key, revision } = fixture(t)
  Object.assign(env, selfHostedEnv)
  const hidden = { ...selfHosted, id: 'hidden-tool', package: '@fixture-private/hidden' }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!('Authorization' in options.headers)) return new Response('unauthorized', { status: 401 })
    return String(url).endsWith('.tgz')
      ? new Response('tarball-bytes', { headers: { 'content-type': 'application/octet-stream' } })
      : selfHostedMetadata(hidden.package, 'https://registry.example.test/hidden-1.0.0.tgz')
  })
  assert.equal((await admin('/plugins', { id: hidden.id, metadata: hidden }, 'POST')).status, 200)
  assert.equal((await admin(`/plugins/${hidden.id}/publish`, { revision: revision(hidden.id), confirmPublic: true }, 'POST')).status, 200)
  const path = '/registry/hidden-tool/' + hidden.package
  assert.ok((await (await call('/v1/plugins', undefined, undefined, { 'X-Dsh-Catalog-Registries': 'npm tokenscowork' })).json()).items.some(item => item.id === hidden.id))
  assert.equal((await call(path)).status, 200)
  assert.equal((await call(path + '/1.0.0/tarball')).status, 200)
  // Restricting the entry gates the proxy; opening it again reopens the proxy. Both are the
  // operator's own call — the Key grant beside it neither closes nor opens anything.
  assert.equal((await access({ keys: [await key('sk-hidden-grant')] }, hidden.id)).status, 200)
  assert.equal((await call(path)).status, 403)
  assert.equal((await call(path, 'sk-hidden-grant')).status, 200)
  assert.equal((await access({ visibility: 'public' }, hidden.id)).status, 200)
  assert.equal((await call(path)).status, 200)
})
