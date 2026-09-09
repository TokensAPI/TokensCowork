import { resetTestCatalog, seedTestPlugin } from './catalog-fixture.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../_worker.js'

const metadata = {
  id: 'test-tool', category: 'optional', package: '@example/test-tool', displayName: 'Test tool',
  summary: 'Fixture plugin', repository: 'https://example.com/tool', version: '1.0.0', npm: false,
}

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  }
  resetTestCatalog(db,metadata)
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => db.prepare(sql).get(...values),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => db.prepare(sql).run(...values),
  })
  const roster = { publisher: { name: 'Fixture' }, items: [{ ...metadata }] }
  const env = {
    MARKET_ADMIN_TOKEN: 'test-admin', MARKET_HMAC_SECRET: 'fixture-hmac',
    MARKET_KEY_ENCRYPTION_SECRET: 'fixture-encryption',
    MARKET_DB: {
      prepare: wrap,
      batch: async statements => {
        db.exec('BEGIN')
        try {
          const results = []
          for (const statement of statements) results.push(await statement.run())
          db.exec('COMMIT')
          return results
        } catch (error) { db.exec('ROLLBACK'); throw error }
      },
    },
    ASSETS: { fetch: async () => Response.json(roster) },
  }
  const call = (path, { body, token, cookie, ip = '192.0.2.1' } = {}) => worker.fetch(
    new Request('https://market.example' + path, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: {
        Origin: 'https://market.example', 'CF-Connecting-IP': ip,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, {},
  )
  const login = (credential = 'wrong', options = {}) => call('/api/admin/login', { ...options, body: { credential } })
  const save = (changes = {}) => call('/api/admin/plugin-access', {
    token: 'test-admin', body: { id: metadata.id, metadata, organizationIds: [], apiKeys: [], keepFingerprints: [], ...changes },
  })
  return { db, env, roster, call, login, save }
}

test('failed logins are bounded per edge IP without storing IPs or credentials', async t => {
  const { login, db } = fixture(t)
  for (let attempt = 0; attempt < 7; attempt++) assert.equal((await login()).status, 401)
  const limited = await login()
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.ok(Number(limited.headers.get('retry-after')) <= 900)
  assert.equal((await login('test-admin')).status, 429)
  assert.equal((await login('test-admin', { ip: '192.0.2.2' })).status, 200)
  const stored = db.prepare('SELECT * FROM market_admin_login_limits').all()
  assert.equal(stored.length, 1)
  assert.match(stored[0].bucket_hash, /^[a-f0-9]{64}$/u)
  assert.ok(!JSON.stringify(stored).includes('192.0.2.1'))
  assert.ok(!JSON.stringify(stored).includes('wrong'))
  db.exec('UPDATE market_admin_login_limits SET expires_at=0')
  assert.equal((await login('test-admin')).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_admin_login_limits').get().n, 0)
})

test('successful login clears failures; anonymous session probes do not count as guesses', async t => {
  const { login, call, db } = fixture(t)
  for (let attempt = 0; attempt < 12; attempt++) assert.equal((await call('/api/admin/access')).status, 401)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_admin_login_limits').get().n, 0)
  assert.equal((await login()).status, 401)
  assert.equal((await login('test-admin')).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_admin_login_limits').get().n, 0)
})

test('invalid admin Bearer tokens cannot bypass throttling and existing sessions remain usable', async t => {
  const { login, call } = fixture(t)
  const cookie = (await login('test-admin')).headers.get('set-cookie').split(';')[0]
  for (let attempt = 0; attempt < 7; attempt++) assert.equal((await call('/api/admin/access', { token: 'wrong' })).status, 401)
  assert.equal((await call('/api/admin/access', { token: 'wrong' })).status, 429)
  assert.equal((await login('test-admin')).status, 429)
  assert.equal((await call('/api/admin/access', { cookie })).status, 200)
  assert.equal((await call('/api/admin/access', { cookie, token: 'wrong' })).status, 200)
})

test('invalid login JSON does not cause a server error', async t => {
  const { call } = fixture(t)
  assert.equal((await call('/api/admin/login', { body: null })).status, 400)
})

test('permission saves retain canonical release metadata and future roster changes', async t => {
  const { save, db, roster, call } = fixture(t)
  const installSource = { kind: 'fixture', url: 'https://example.com/package.tgz' }
  seedTestPlugin(db,{ ...metadata, version: '2.0.0', installSource, summary: 'New release' })
  assert.equal((await save()).status, 200)
  const saved = JSON.parse(db.prepare('SELECT metadata FROM market_plugins').get().metadata)
  assert.equal(saved.version, '2.0.0')
  assert.deepEqual(saved.installSource, installSource)
  seedTestPlugin(db,{...metadata,installSource,version:'3.0.0',displayName:'Latest name'})
  const items = (await (await call('/roster.json')).json()).items
  assert.equal(items[0].version, '3.0.0')
  assert.equal(items[0].displayName, 'Latest name')
  assert.deepEqual(items[0].installSource, installSource)
})

test('custom plugin records remain usable without a release roster entry', async t => {
  const { save, roster, call } = fixture(t)
  roster.items = []
  assert.equal((await save()).status, 200)
  const items = (await (await call('/roster.json')).json()).items
  assert.equal(items[0].id, metadata.id)
  assert.equal(items[0].version, '1.0.0')
})

test('archived catalog entries never invoke organization authorization or return metadata',async t=>{
 const {save,call,env,db}=fixture(t)
 await save({apiKeys:['sk-direct']})
 db.prepare("UPDATE market_catalog SET state='archived',revision=revision+1").run()
 let calls=0;env.MARKET_ORGANIZATIONS={resolveOrganization:async()=>{calls++;throw new Error('offline')}}
 assert.deepEqual((await (await call('/roster.json',{token:'sk-unrelated-key'})).json()).items,[])
 assert.equal(calls,0)
})

test('operations exposes safe configuration and bounded recent actions only to administrators', async t => {
  const { call, env, db } = fixture(t)
  env.MARKET_ORGANIZATIONS_BASE_URL = 'https://tokensapi.ai'
  env.MARKET_ORGANIZATIONS_TOKEN = 'fixture-private-management-token'
  assert.equal((await call('/api/admin/operations')).status, 401)
  assert.equal((await call('/api/admin/operations', { token: 'sk-customer' })).status, 401)
  for (let i = 0; i < 60; i++) db.prepare('INSERT INTO market_admin_audit(action,target,details,created_at) VALUES(?,?,?,?)')
    .run('organization.updated', String(i + 1), JSON.stringify({ enabled: true }), i)
  const response = await call('/api/admin/operations', { token: 'test-admin' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const value = await response.json()
  assert.deepEqual(value.environment, {
    origin: 'https://tokensapi.ai', name: 'production', organizationReady: true,
    organizationListReady: true, keyDisplayReady: true, privatePackagesReady: false,
  })
  assert.equal(value.recentActions.length, 50)
  assert.equal(value.recentActions[0].target, '60')
  assert.equal(value.recentActions[0].createdAt, 59)
  for (const secret of ['fixture-private-management-token', 'fixture-encryption', 'fixture-hmac', 'test-admin']) {
    assert.ok(!JSON.stringify(value).includes(secret))
  }
})

test('permission and organization saves plus empty sync are atomically audited without credentials', async t => {
  const { call, save, env, db } = fixture(t)
  env.MARKET_ORGANIZATIONS_BASE_URL = 'https://dev.tokensapi.ai'
  env.MARKET_ORGANIZATIONS = { listOrganizations: async () => [] }
  assert.equal((await call('/api/admin/organizations', { token: 'test-admin', body: { id: 7, name: 'Seven', enabled: true } })).status, 200)
  assert.equal((await save({ organizationIds: [7], apiKeys: ['sk-sensitive-direct'] })).status, 200)
  assert.equal((await call('/api/admin/organizations/sync', { token: 'test-admin', body: {} })).status, 200)
  const audit = db.prepare('SELECT action,target,details FROM market_admin_audit ORDER BY id').all()
  assert.deepEqual(audit.map(row => row.action), ['organization.updated', 'plugin.access.updated', 'organizations.synced'])
  assert.deepEqual(JSON.parse(audit[1].details), { visibility: 'restricted', organizationCount: 1, keyCount: 1 })
  assert.deepEqual(JSON.parse(audit[2].details), { count: 0 })
  assert.equal(audit[2].target, 'development')
  assert.ok(!JSON.stringify(audit).includes('sk-sensitive-direct'))
  assert.ok(!JSON.stringify(audit).includes('test-admin'))

  // If audit persistence fails, authorization and organization writes roll back too.
  db.exec('DROP TABLE market_admin_audit')
  assert.equal((await save({ organizationIds: [7], apiKeys: ['sk-replacement'] })).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_plugin_key_grants').get().n, 1)
  assert.equal((await (await call('/roster.json', { token: 'sk-sensitive-direct' })).json()).items.length, 1)
  assert.equal((await call('/api/admin/organizations', { token: 'test-admin', body: { id: 8, name: 'Eight', enabled: true } })).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_organizations WHERE id=8').get().n, 0)
})

test('sync changes roll back if their audit entry cannot be recorded', async t => {
  const { call, env, db } = fixture(t)
  env.MARKET_ORGANIZATIONS = { listOrganizations: async () => [{ id: 9, name: 'Nine' }] }
  db.exec('DROP TABLE market_admin_audit')
  assert.equal((await call('/api/admin/organizations/sync', { token: 'test-admin', body: {} })).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_organizations').get().n, 0)
})

test('request parsing rejects non-object JSON before administrator mutations', async t => {
  const { call, db } = fixture(t)
  for (const body of [null, [], 1, 'invalid', true]) {
    assert.equal((await call('/api/admin/organizations', { token: 'test-admin', body })).status, 400)
    assert.equal((await call('/api/admin/access-preview', { token: 'test-admin', body })).status, 400)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_admin_audit').get().n, 0)
})

test('invalid Key stops before catalog or grant lookup even when a direct grant exists', async t => {
  const {call,save,env}=fixture(t)
  await save({apiKeys:['sk-invalid']})
  env.MARKET_ORGANIZATIONS={validateApiKey:async()=>({status:'invalid',organization:null})}
  const prepare=env.MARKET_DB.prepare
  env.MARKET_DB.prepare=(sql)=>{
    assert.ok(!sql.includes('FROM market_catalog')&&!sql.includes('JOIN market_catalog')&&!sql.includes('FROM market_plugin_key_grants'))
    return prepare(sql)
  }
  const response=await call('/api/admin/access-preview',{token:'test-admin',body:{apiKey:'sk-invalid'}})
  assert.equal(response.status,200)
  const value=await response.json()
  assert.equal(value.keyStatus,'invalid');assert.equal(value.permissionsEvaluated,false);assert.deepEqual(value.items,[])
  assert.ok(!JSON.stringify(value).includes('sk-invalid'))
})

test('access preview shares catalog decisions and resolves identity only once without recording the Key', async t => {
  const { call, save, env, db, roster } = fixture(t)
  let lookups = 0
  env.MARKET_ORGANIZATIONS = { resolveOrganization: async key => { lookups++; return { id: key === 'sk-seven' ? 7 : 8, name: 'Test organization' } } }
  env.MARKET_ORGANIZATIONS.validateApiKey = async key => ({status:'valid',organization:await env.MARKET_ORGANIZATIONS.resolveOrganization(key)})
  assert.equal((await call('/api/admin/organizations', { token: 'test-admin', body: { id: 7, name: 'Seven', enabled: true } })).status, 200)
  assert.equal((await save({ organizationIds: [7], apiKeys: ['sk-direct'] })).status, 200)
  seedTestPlugin(db,{ ...metadata, id: 'public-tool', displayName: 'Public tool' })
  const denied = { ...metadata, id: 'denied-tool', displayName: 'Denied tool' }
  seedTestPlugin(db,denied)
  assert.equal((await save({ id: denied.id, metadata: denied, apiKeys: ['sk-another'] })).status, 200)
  const initialAuditCount = db.prepare('SELECT COUNT(*) AS n FROM market_admin_audit').get().n
  for (const apiKey of ['sk-seven', 'sk-direct', 'sk-other']) {
    lookups = 0
    const response = await call('/api/admin/access-preview', { token: 'test-admin', body: { apiKey } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const preview = await response.json()
    assert.equal(lookups, 1)
    assert.ok(!JSON.stringify(preview).includes(apiKey))
    assert.equal(preview.catalogAvailable, true)
    const actual = (await (await call('/roster.json', { token: apiKey })).json()).items.map(item => item.id).sort()
    assert.deepEqual(preview.items.filter(item => item.allowed).map(item => item.id).sort(), actual)
    assert.equal(preview.items.find(item => item.id === 'public-tool').reason, 'public')
    assert.equal(preview.items.find(item => item.id === 'denied-tool').reason, 'denied')
    assert.equal(preview.items.find(item => item.id === metadata.id).reason, apiKey === 'sk-seven' ? 'organization' : apiKey === 'sk-direct' ? 'direct' : 'denied')
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_admin_audit').get().n, initialAuditCount)
  assert.equal((await call('/api/admin/access-preview', { body: { apiKey: 'sk-seven' } })).status, 401)
})

test('access preview handles personal Keys, disabled organizations and upstream failures safely', async t => {
  const { call, save, env, db } = fixture(t)
  assert.equal((await call('/api/admin/organizations', { token: 'test-admin', body: { id: 7, name: 'Seven', enabled: false } })).status, 200)
  assert.equal((await save({ organizationIds: [7], apiKeys: ['sk-direct'] })).status, 200)
  const preview = async apiKey => (await (await call('/api/admin/access-preview', { token: 'test-admin', body: { apiKey } })).json())
  env.MARKET_ORGANIZATIONS = { resolveOrganization: async () => null }
  env.MARKET_ORGANIZATIONS.validateApiKey = async key => ({status:'valid',organization:await env.MARKET_ORGANIZATIONS.resolveOrganization(key)})
  let value = await preview('sk-personal')
  assert.equal(value.organizationStatus, 'none')
  assert.equal(value.organization, null)
  assert.equal(value.summary.allowed, 0)
  env.MARKET_ORGANIZATIONS.resolveOrganization = async () => ({ id: 7, name: 'Seven' })
  value = await preview('sk-disabled')
  assert.equal(value.organizationStatus, 'matched')
  assert.equal(value.organization.enabled, false)
  assert.equal(value.summary.allowed, 0)
  env.MARKET_ORGANIZATIONS.resolveOrganization = async () => { throw new Error('Sensitive upstream body sk-secret') }
  value = await preview('sk-direct')
  assert.equal(value.organizationStatus, 'unavailable')
  assert.equal(value.catalogAvailable, false)
  assert.equal(value.keyStatus, 'unavailable')
  assert.equal(value.permissionsEvaluated, false)
  assert.deepEqual(value.items, [])
  value = await preview('sk-unrecognized')
  assert.equal(value.organizationStatus, 'unavailable')
  assert.equal(value.catalogAvailable, false)
  assert.equal(value.summary.allowed, 0)
  assert.ok(!JSON.stringify(value).includes('Sensitive'))
  assert.ok(!JSON.stringify(value).includes('sk-secret'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_admin_audit').get().n, 2)
})

test('operational audit retention stays bounded after subsequent changes', async t => {
  const { db, save } = fixture(t)
  for (let i = 0; i < 1005; i++) db.prepare('INSERT INTO market_admin_audit(action,target,details,created_at) VALUES(?,?,?,?)')
    .run('organization.updated', String(i + 1), '{}', i)
  assert.equal((await save()).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_admin_audit').get().n, 1000)
})
