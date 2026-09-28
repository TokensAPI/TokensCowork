import { resetTestCatalog, seedTestPlugin } from './catalog-fixture.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from '../_worker.js'
import { createAssets } from '../runtime/adapters.mjs'
import { fingerprint } from '../security/key-fingerprint.js'

const metadata = {
  id: 'test-tool', category: 'optional', package: '@example/test-tool', displayName: 'Test tool',
  summary: 'Fixture plugin', repository: 'https://example.com/tool', version: '1.0.0', npm: false,
}

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  }
  resetTestCatalog(db, metadata)
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => db.prepare(sql).get(...values),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => db.prepare(sql).run(...values),
  })
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
    ASSETS: createAssets(resolve(fileURLToPath(new URL('..', import.meta.url)))),
  }
  const call = (path, { body, token, cookie, ip = '192.0.2.1', method = body === undefined ? 'GET' : 'PUT' } = {}) => worker.fetch(
    new Request('https://market.example' + path, {
      method,
      headers: {
        Origin: 'https://market.example', 'CF-Connecting-IP': ip,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, {},
  )
  const admin = (path, body, method) => call('/api/v1' + path, { token: 'test-admin', body, method })
  const login = (credential = 'wrong', options = {}) => call('/api/v1/session', { ...options, body: { credential } })
  const key = async raw => (await (await admin('/keys', { key: raw, label: 'fixture' }, 'POST')).json()).fingerprint
  const save = async (changes = {}, id = metadata.id) => admin(`/plugins/${id}/access`, {
    visibility: 'restricted', organizations: [], keys: [],
    revision: db.prepare('SELECT revision FROM market_plugins WHERE id=?').get(id).revision, ...changes,
  })
  return { db, env, call, admin, login, key, save }
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
  const stored = db.prepare('SELECT * FROM market_login_limits').all()
  assert.equal(stored.length, 1)
  assert.match(stored[0].bucket_hash, /^[a-f0-9]{64}$/u)
  assert.ok(!JSON.stringify(stored).includes('192.0.2.1'))
  assert.ok(!JSON.stringify(stored).includes('wrong'))
  db.exec('UPDATE market_login_limits SET expires_at=0')
  assert.equal((await login('test-admin')).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_login_limits').get().n, 0)
})

test('successful login clears failures; anonymous session probes do not count as guesses', async t => {
  const { login, call, db } = fixture(t)
  for (let attempt = 0; attempt < 12; attempt++) {
    assert.equal((await call('/api/v1/plugins')).status, 401)
    assert.equal((await (await call('/api/v1/session')).json()).authenticated, false)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_login_limits').get().n, 0)
  assert.equal((await login()).status, 401)
  assert.equal((await login('test-admin')).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_login_limits').get().n, 0)
})

test('invalid admin Bearer tokens are throttled apart from the console login', async t => {
  const { login, call } = fixture(t)
  const cookie = (await login('test-admin')).headers.get('set-cookie').split(';')[0]
  for (let attempt = 0; attempt < 7; attempt++) assert.equal((await call('/api/v1/plugins', { token: 'wrong' })).status, 401)
  assert.equal((await call('/api/v1/plugins', { token: 'wrong' })).status, 429)
  assert.equal((await call('/api/v1/plugins', { token: 'test-admin' })).status, 429)
  // A Bearer header is decisive: a wrong one never falls back to the cookie riding beside it.
  assert.equal((await call('/api/v1/plugins', { cookie, token: 'wrong', ip: '192.0.2.9' })).status, 401)
  // The console login keeps its own budget, and the session keeps working.
  assert.equal((await login('test-admin')).status, 200)
  assert.equal((await call('/api/v1/plugins', { cookie })).status, 200)
})

test('request parsing rejects non-object JSON before any mutation', async t => {
  const { call, admin, db } = fixture(t)
  assert.equal((await call('/api/v1/session', { body: null })).status, 400)
  for (const body of [null, [], 1, 'invalid', true]) {
    assert.equal((await admin('/organizations/7', body)).status, 400, JSON.stringify(body))
    assert.equal((await admin('/keys', body, 'POST')).status, 400, JSON.stringify(body))
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_audit_events').get().n, 0)
})

test('access saves keep release metadata, and roster changes show through', async t => {
  const { save, db, call } = fixture(t)
  const installSource = { kind: 'fixture', url: 'https://example.com/package.tgz' }
  seedTestPlugin(db, { ...metadata, version: '2.0.0', installSource, summary: 'New release' })
  assert.equal((await save({ visibility: 'public' })).status, 200)
  const saved = JSON.parse(db.prepare('SELECT metadata FROM market_plugins').get().metadata)
  assert.equal(saved.version, '2.0.0')
  assert.deepEqual(saved.installSource, installSource)
  seedTestPlugin(db, { ...metadata, installSource, version: '3.0.0', displayName: 'Latest name' })
  const items = (await (await call('/roster.json')).json()).items
  assert.equal(items[0].version, '3.0.0')
  assert.equal(items[0].displayName, 'Latest name')
  assert.deepEqual(items[0].installSource, installSource)
})

test('archived entries never invoke organization authorization or return metadata', async t => {
  const { save, key, call, env, db } = fixture(t)
  await save({ keys: [await key('sk-direct')] })
  db.prepare("UPDATE market_plugins SET state='archived',revision=revision+1").run()
  let calls = 0; env.MARKET_ORGANIZATIONS = { resolveOrganization: async () => { calls++; throw new Error('offline') } }
  assert.deepEqual((await (await call('/roster.json', { token: 'sk-unrelated-key' })).json()).items, [])
  assert.deepEqual((await (await call('/roster.json', { token: 'sk-direct' })).json()).items, [])
  assert.equal(calls, 0)
})

test('the session exposes safe configuration and the audit log only to administrators', async t => {
  const { call, admin, env, db } = fixture(t)
  env.MARKET_ORGANIZATIONS_BASE_URL = 'https://tokensapi.ai'
  env.MARKET_ORGANIZATIONS_TOKEN = 'fixture-private-management-token'
  assert.equal((await call('/api/v1/audit')).status, 401)
  assert.equal((await call('/api/v1/audit', { token: 'sk-customer' })).status, 401)
  assert.equal((await (await call('/api/v1/session')).json()).environment, undefined)
  for (let i = 0; i < 120; i++) db.prepare('INSERT INTO market_audit_events(actor_kind,actor_id,action,target,details,created_at) VALUES(?,?,?,?,?,?)')
    .run('root', '', 'organization.updated', String(i + 1), JSON.stringify({ enabled: true }), i)
  const response = await admin('/audit')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const log = await response.json()
  assert.equal(log.items.length, 100)
  assert.equal(log.items[0].target, '120')
  assert.equal(log.items[0].createdAt, 119)
  const session = await (await admin('/session')).json()
  assert.deepEqual(session.environment, {
    origin: 'https://tokensapi.ai', name: 'production', organizationReady: true,
    keyDisplayReady: true, privateRegistryReady: false,
  })
  for (const secret of ['fixture-private-management-token', 'fixture-encryption', 'fixture-hmac', 'test-admin']) {
    assert.ok(!JSON.stringify([log, session]).includes(secret))
  }
})

test('access, organization and sync writes are atomically audited without credentials', async t => {
  const { admin, save, key, call, env, db } = fixture(t)
  env.MARKET_ORGANIZATIONS_BASE_URL = 'https://dev.tokensapi.ai'
  env.MARKET_ORGANIZATIONS = { listOrganizations: async () => [] }
  assert.equal((await admin('/organizations/7', { name: 'Seven', enabled: true })).status, 200)
  const fp = await key('sk-sensitive-direct')
  assert.equal((await save({ organizations: [7], keys: [fp] })).status, 200)
  assert.equal((await admin('/organizations/sync', {}, 'POST')).status, 200)
  const audit = db.prepare('SELECT action,target,details FROM market_audit_events ORDER BY id').all()
  assert.deepEqual(audit.map(row => row.action), ['organization.updated', 'key.added', 'plugin.access.updated', 'organizations.synced'])
  assert.deepEqual(JSON.parse(audit[2].details), { visibility: 'restricted', organizationCount: 1, keyCount: 1, userCount: 0 })
  assert.deepEqual(JSON.parse(audit[3].details), { count: 0 })
  assert.equal(audit[3].target, 'development')
  assert.ok(!JSON.stringify(audit).includes('sk-sensitive-direct'))
  assert.ok(!JSON.stringify(audit).includes('test-admin'))

  // If the audit entry cannot be written, the change it describes rolls back too.
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON market_audit_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  assert.equal((await save({ organizations: [], keys: [] })).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_grants').get().n, 2)
  assert.equal((await (await call('/roster.json', { token: 'sk-sensitive-direct' })).json()).items.length, 1)
  assert.equal((await admin('/organizations/8', { name: 'Eight', enabled: true })).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_organizations WHERE id=8').get().n, 0)
  assert.equal((await admin('/keys', { key: 'sk-another', label: 'x' }, 'POST')).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_keys').get().n, 1)
  env.MARKET_ORGANIZATIONS = { listOrganizations: async () => [{ id: 9, name: 'Nine' }] }
  assert.equal((await admin('/organizations/sync', {}, 'POST')).status, 503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_organizations WHERE id=9').get().n, 0)
})

test('operational audit retention stays bounded after subsequent changes', async t => {
  const { db, save } = fixture(t)
  for (let i = 0; i < 5005; i++) db.prepare('INSERT INTO market_audit_events(actor_kind,actor_id,action,target,details,created_at) VALUES(?,?,?,?,?,?)')
    .run('root', '', 'organization.updated', String(i + 1), '{}', i)
  assert.equal((await save()).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_audit_events').get().n, 5000)
})

test('Key fingerprints in the directory are keyed, never the raw value', async t => {
  const { key, db, env } = fixture(t)
  const fp = await key('sk-directory')
  assert.equal(fp, await fingerprint('sk-directory', env.MARKET_HMAC_SECRET))
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM market_keys').all()).includes('sk-directory'))
})

test('every console module the page loads is on the asset allowlist', async t => {
  const { call } = fixture(t)
  const read = name => readFileSync(new URL('../admin/' + name, import.meta.url), 'utf8')
  // The console is an ES module graph, so a new panel reaches the browser only if its file is
  // both imported and allowlisted in market-worker.js. Walk the graph instead of trusting a list.
  const pending = [...read('index.html').matchAll(/(?:src|href)="\/admin\/assets\/([\w.-]+)"/gu)].map(m => m[1])
  const seen = new Set()
  while (pending.length) {
    const name = pending.pop()
    if (seen.has(name)) continue
    seen.add(name)
    if (!name.endsWith('.js')) continue
    for (const match of read('assets/' + name).matchAll(/from '\.\/([\w.-]+)'/gu)) pending.push(match[1])
  }
  for (const name of ['market-admin.js', 'market-organizations.js', 'market-keys.js', 'market-users.js', 'market-grants.js', 'market-catalog-editor.js']) assert.ok(seen.has(name), name)
  for (const name of seen) {
    assert.equal((await call('/admin/assets/' + name)).status, 200, name)
  }
  // The API reference is a separate page, and everything it needs is vendored: the console must
  // stay usable on a machine with no route to the internet, so the page may only load same-origin
  // files and every one of them has to be allowlisted.
  const docs = read('api-docs.html')
  assert.equal((await call('/admin/api-docs.html')).status, 200)
  for (const [, reference] of docs.matchAll(/(?:src|href)="([^"]+)"/gu)) {
    assert.ok(reference.startsWith('/'), `api-docs.html loads ${reference} from another origin`)
    if (reference !== '/admin/') assert.equal((await call(reference)).status, 200, reference)
  }
  // The /admin/* CSP is script-src 'self'; style-src 'self' with no 'unsafe-inline', so an inline
  // block would be dropped by the browser without any error the server could see.
  assert.doesNotMatch(docs, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle="/u)
  // Swagger UI phones home to draw a validation badge unless it is told not to.
  assert.match(read('assets/api-docs.js'), /validatorUrl: null/u)
  // The page pre-authorizes from a path only the loopback QA server answers; the worker must never serve it.
  assert.equal((await call('/__dev/docs-credential')).status, 404)
  assert.ok(readFileSync(new URL('../admin/assets/vendor/swagger-ui-bundle.js', import.meta.url), 'utf8').length > 500000)
  // And nothing outside that graph is reachable, so the allowlist cannot quietly widen.
  for (const name of ['market-nonexistent.js', 'market-subjects.js', 'market-tenants.js', 'market-service-clients.js', 'market-available.js'])
    assert.equal((await call('/admin/assets/' + name)).status, 404, name)
  assert.equal((await call('/server/services/auth.js')).status, 404)
})
