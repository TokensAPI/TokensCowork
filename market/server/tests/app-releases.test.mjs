import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import worker from '../_worker.js'
import { compareVersions, rolloutBucket, purgeStaleInstallations, APP_RELEASES_URL } from '../services/app-releases.js'

// Independent fixtures: an in-memory database, two registered organizations (7 and 9) and a fake
// TokensAPI that knows a few Keys. No network, no production data.
const ORIGIN = 'https://market.example'
const DAY = 24 * 60 * 60 * 1000

function fixture(t, { provider = true } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  db.exec("INSERT INTO market_organizations(id,name,enabled) VALUES(7,'Seven',1),(9,'Nine',1)")
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const lookups = []
  const identities = {
    'sk-seven': { organization: { id: 7, name: 'Seven' }, user: { id: 501, name: 'Owner' } },
    'sk-nine': { organization: { id: 9, name: 'Nine' }, user: { id: 502, name: 'Other' } },
    'sk-alone': { organization: null, user: { id: 503, name: 'Alone' } },
  }
  const env = {
    MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } },
    ...(provider ? { MARKET_ORGANIZATIONS: {
      resolveOrganization: async () => null,
      resolveIdentity: async key => {
        lookups.push(key)
        if (key === 'sk-down') throw new Error('TokensAPI unreachable')
        if (key === 'sk-slow') return new Promise(() => {})
        return identities[key] ?? { organization: null, user: null }
      },
      resolveAccount: async c => (c.userId === 701 ? { id: 701, displayName: 'Tenant' } : null),
      resolveMyOrg: async c => (c.userId === 701 ? { id: 7, name: 'Seven', role: 100 } : null),
      // The TokensAPI users the console can name and put on a user list (T0112); 999 makes it fail.
      searchUsers: async keyword => {
        if (keyword === '999') throw new Error('TokensAPI unreachable')
        const items = Object.values(identities).map(i => i.user).filter(Boolean).filter(user => String(user.id) === keyword)
          .map(user => ({ ...user, username: '', organizationId: Object.values(identities).find(i => i.user === user)?.organization?.id ?? null }))
        return { items, total: items.length }
      },
    } } : {}),
  }
  const update = async (query, { id = INSTALL.low, key, headers = {} } = {}) => {
    const response = await worker.fetch(new Request(`${ORIGIN}/v1/app/update?${query}`, {
      headers: { ...(id ? { 'X-Installation-Id': id } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } }), env, {})
    return { status: response.status, json: await response.json(), headers: response.headers }
  }
  const admin = async (method, path, data, auth = { Authorization: 'Bearer admin-secret' }) => {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: { Origin: ORIGIN, ...auth },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
    return { status: response.status, json: await response.json() }
  }
  // A rollout as the console sets it up: created, then changed.
  const release = async (version, change) => {
    assert.equal((await admin('POST', '/app-releases', { version })).status, 200)
    if (change) assert.equal((await admin('PATCH', `/app-releases/${version}`, change)).status, 200, JSON.stringify(change))
  }
  return { db, env, update, admin, release, lookups }
}

// Installation ids whose bucket for 0.8.0 is known: one in the first 10 %, one in the last 10 %.
const INSTALL = await (async () => {
  let low, high
  while (!low || !high) {
    const id = randomUUID()
    const bucket = await rolloutBucket(id, '0.8.0')
    if (bucket < 10) low ??= id
    if (bucket >= 90) high ??= id
  }
  return { low, high }
})()

test('versions compare by number, a pre-release below its release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('0.8.0', '0.8.0-rc.1') > 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('0.7.19', '0.8.0') < 0)
})

test('the bucket is fixed per installation and version, and differs between versions', async () => {
  assert.equal(await rolloutBucket(INSTALL.low, '0.8.0'), await rolloutBucket(INSTALL.low, '0.8.0'))
  const ids = Array.from({ length: 200 }, () => randomUUID())
  const a = await Promise.all(ids.map(id => rolloutBucket(id, '0.8.0')))
  const b = await Promise.all(ids.map(id => rolloutBucket(id, '0.9.0')))
  assert.ok(a.every(n => Number.isInteger(n) && n >= 0 && n < 100))
  assert.ok(a.some((n, i) => n !== b[i]))
})

test('the percentage reaches the installations below it, on a manual check too; anonymous callers work', async t => {
  const { update, release } = fixture(t)
  await release('0.8.0', { status: 'rolling', percent: 10 })
  const low = await update('version=0.7.19&platform=win32&arch=x64')
  assert.equal(low.status, 200)
  assert.deepEqual(low.json, { version: '0.8.0' })
  assert.equal(low.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await update('version=0.7.19', { id: INSTALL.high })).json, { version: null })
  // A manual check follows the same rules: outside the bucket it gets nothing either.
  assert.deepEqual((await update('version=0.7.19&manual=1', { id: INSTALL.high })).json, { version: null })
  assert.deepEqual((await update('version=0.7.19&manual=1')).json, { version: '0.8.0' })
})

test('the hold list beats the early list, the percentage and a manual check', async t => {
  const { update, release } = fixture(t)
  await release('0.8.0', { status: 'rolling', percent: 100, early: [9], hold: [7] })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-seven' })).json, { version: null })
  assert.deepEqual((await update('version=0.7.19&manual=1', { key: 'sk-seven' })).json, { version: null })
  // Others still get it.
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-nine', id: INSTALL.high })).json, { version: '0.8.0' })
})

test('the early list gets a version at 0 %; nobody else does until it is raised', async t => {
  const { update, release, admin } = fixture(t)
  await release('0.8.0', { status: 'rolling', percent: 0, early: [7] })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-seven', id: INSTALL.high })).json, { version: '0.8.0' })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-nine', id: INSTALL.low })).json, { version: null })
  assert.deepEqual((await update('version=0.7.19', { id: INSTALL.low })).json, { version: null })
  assert.equal((await admin('PATCH', '/app-releases/0.8.0', { percent: 10 })).status, 200)
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-nine', id: INSTALL.low })).json, { version: '0.8.0' })
})

test('drafts and paused versions reach nobody, not even the early list or a manual check', async t => {
  const { update, release, admin } = fixture(t)
  await release('0.8.0', { early: [7] })
  assert.deepEqual((await update('version=0.7.19&manual=1', { key: 'sk-seven' })).json, { version: null })
  await admin('PATCH', '/app-releases/0.8.0', { status: 'rolling', percent: 100 })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-seven' })).json, { version: '0.8.0' })
  await admin('PATCH', '/app-releases/0.8.0', { status: 'paused' })
  assert.deepEqual((await update('version=0.7.19&manual=1', { key: 'sk-seven' })).json, { version: null })
  // Resuming keeps the percentage it had.
  await admin('PATCH', '/app-releases/0.8.0', { status: 'rolling' })
  assert.deepEqual((await update('version=0.7.19', { id: INSTALL.high })).json, { version: '0.8.0' })
})

test('never a downgrade or the same version; of several, the highest the caller qualifies for', async t => {
  const { update, release } = fixture(t)
  await release('0.7.18', { status: 'full' })
  await release('0.8.0', { status: 'full' })
  await release('0.9.0', { status: 'rolling', percent: 0, early: [7] })
  assert.deepEqual((await update('version=0.9.0&manual=1')).json, { version: null })
  assert.deepEqual((await update('version=0.9.1&manual=1')).json, { version: null })
  assert.deepEqual((await update('version=0.7.19')).json, { version: '0.8.0' })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-seven' })).json, { version: '0.9.0' })
  // A manual check gets what a background check gets: 0.9.0 only on its early list.
  assert.deepEqual((await update('version=0.7.19&manual=1')).json, { version: '0.8.0' })
  assert.deepEqual((await update('version=0.7.19&manual=1', { key: 'sk-seven' })).json, { version: '0.9.0' })
  // A pre-release of a version is below it.
  assert.deepEqual((await update('version=0.8.0-rc.1')).json, { version: '0.8.0' })
})

test('a held organization still gets a lower version it is not held from', async t => {
  const { update, release } = fixture(t)
  await release('0.8.0', { status: 'full' })
  await release('0.9.0', { status: 'full', hold: [7] })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-seven' })).json, { version: '0.8.0' })
})

test('no Key, a Key without organization, TokensAPI down or slow, or no provider: treated as no organization', async t => {
  const { update, release, lookups } = fixture(t)
  await release('0.8.0', { status: 'rolling', percent: 10, hold: [7] })
  assert.deepEqual((await update('version=0.7.19')).json, { version: '0.8.0' })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-alone' })).json, { version: '0.8.0' })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-down' })).json, { version: '0.8.0' })
  const started = Date.now()
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-slow' })).json, { version: '0.8.0' })
  assert.ok(Date.now() - started < 6000)
  assert.deepEqual(lookups, ['sk-alone', 'sk-down', 'sk-slow'])
  const bare = fixture(t, { provider: false })
  await bare.release('0.8.0', { status: 'rolling', percent: 10 })
  assert.deepEqual((await bare.update('version=0.7.19', { key: 'sk-seven' })).json, { version: '0.8.0' })
})

test('the request is checked: installation id, version and lengths; GET only', async t => {
  const { update, env } = fixture(t)
  assert.equal((await update('version=0.7.19', { id: '' })).status, 400)
  assert.equal((await update('version=0.7.19', { id: 'not-a-uuid' })).status, 400)
  assert.equal((await update('')).status, 400)
  assert.equal((await update('version=latest')).status, 400)
  assert.equal((await update(`version=0.7.19&platform=${'x'.repeat(65)}`)).status, 400)
  assert.equal((await update('version=0.7.19&arch=x 64')).status, 400)
  const ok = await update('version=0.7.19')
  assert.deepEqual([ok.status, ok.json], [200, { version: null }])
  const post = await worker.fetch(new Request(`${ORIGIN}/v1/app/update?version=0.7.19`, { method: 'POST', headers: { 'X-Installation-Id': INSTALL.low } }), env, {})
  assert.equal(post.status, 405)
})

test('each check records the installation; a failed write does not change the answer; 90-day cleanup', async t => {
  const { db, env, update, release } = fixture(t)
  await release('0.8.0', { status: 'full' })
  await update('version=0.7.19&platform=win32&arch=x64', { key: 'sk-seven', id: INSTALL.low.toUpperCase() })
  let row = db.prepare('SELECT * FROM app_installations').get()
  assert.deepEqual({ ...row, first_seen_at: 0, last_seen_at: 0 }, { installation_id: INSTALL.low, version: '0.7.19', platform: 'win32', arch: 'x64',
    account_id: 501, offered_version: '0.8.0', first_seen_at: 0, last_seen_at: 0 })
  // After upgrading, signed out: the version moves, the account is kept, nothing is offered.
  await update('version=0.8.0&platform=win32&arch=x64')
  row = db.prepare('SELECT * FROM app_installations').get()
  assert.deepEqual([row.version, row.account_id, row.offered_version], ['0.8.0', 501, null])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_installations').get().n, 1)
  // A broken table never breaks the check.
  db.exec('ALTER TABLE app_installations RENAME TO app_installations_moved')
  const errors = t.mock.method(console, 'error', () => {})
  assert.deepEqual((await update('version=0.7.19', { id: INSTALL.high })).json, { version: '0.8.0' })
  assert.equal(errors.mock.callCount(), 1)
  db.exec('ALTER TABLE app_installations_moved RENAME TO app_installations')
  // Cleanup removes only rows not seen for 90 days.
  db.prepare("INSERT INTO app_installations(installation_id,version,first_seen_at,last_seen_at) VALUES(?,?,?,?)").run(randomUUID(), '0.7.1', 0, Date.now() - 91 * DAY)
  db.prepare("INSERT INTO app_installations(installation_id,version,first_seen_at,last_seen_at) VALUES(?,?,?,?)").run(randomUUID(), '0.7.2', 0, Date.now() - 89 * DAY)
  assert.equal(await purgeStaleInstallations(env), 1)
  assert.deepEqual(db.prepare('SELECT version FROM app_installations ORDER BY version').all().map(r => r.version), ['0.7.2', '0.8.0'])
})

test('the console list: lists, counts over the last 7 days, offered and upgraded', async t => {
  const { db, admin, release, update } = fixture(t)
  await release('0.8.0', { status: 'rolling', percent: 10, early: [9], hold: [7], note: '先给内部' })
  await release('0.9.0')
  await update('version=0.7.19', { id: INSTALL.low }) // offered 0.8.0, not yet installed
  await update('version=0.7.19', { id: INSTALL.high }) // not offered
  const done = randomUUID()
  await update('version=0.8.0', { id: done }) // already on 0.8.0
  db.prepare("INSERT INTO app_installations(installation_id,version,offered_version,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)").run(randomUUID(), '0.8.0', null, 0, Date.now() - 8 * DAY)
  const { status, json } = await admin('GET', '/app-releases')
  assert.equal(status, 200)
  assert.deepEqual(json.items.map(item => [item.version, item.status, item.percent, item.early, item.hold, item.offered, item.upgraded, item.note]), [
    ['0.9.0', 'draft', 0, [], [], 0, 0, ''],
    ['0.8.0', 'rolling', 10, [9], [7], 2, 1, '先给内部'],
  ])
  assert.deepEqual(json.installations, { days: 7, total: 3, versions: [{ version: '0.8.0', count: 1 }, { version: '0.7.19', count: 2 }] })
})

test('the console writes: validation, the status rules, draft-only delete, every change audited', async t => {
  const { db, admin, release } = fixture(t)
  assert.equal((await admin('POST', '/app-releases', { version: '0.8.0-rc.1' })).status, 400)
  assert.equal((await admin('POST', '/app-releases', { version: 'latest' })).status, 400)
  assert.equal((await admin('POST', '/app-releases', { version: 'v0.8.0' })).status, 200)
  assert.equal((await admin('POST', '/app-releases', { version: '0.8.0' })).status, 409)
  const patch = (data, version = '0.8.0') => admin('PATCH', `/app-releases/${version}`, data)
  assert.equal((await patch({})).status, 400)
  assert.equal((await patch({ percent: 101 })).status, 400)
  assert.equal((await patch({ percent: 5.5 })).status, 400)
  assert.equal((await patch({ status: 'live' })).status, 400)
  assert.equal((await patch({ early: [7], hold: [7] })).status, 400)
  assert.equal((await patch({ early: [7, 7] })).status, 400)
  assert.equal((await patch({ early: [404] })).status, 400)
  assert.equal((await patch({ percent: 5 }, '0.9.9')).status, 404)
  assert.equal((await patch({ early: [7] })).status, 200)
  // The other list is checked against the one already saved.
  assert.equal((await patch({ hold: [7] })).status, 400)
  assert.equal((await patch({ status: 'full', percent: 50 })).status, 400)
  assert.equal((await patch({ status: 'full' })).status, 200)
  assert.equal(db.prepare("SELECT percent FROM app_release_rollouts WHERE version='0.8.0'").get().percent, 100)
  assert.equal((await patch({ status: 'draft' })).status, 409)
  assert.equal((await admin('DELETE', '/app-releases/0.8.0')).status, 409)
  await release('0.9.0')
  assert.equal((await admin('DELETE', '/app-releases/0.9.0')).status, 200)
  assert.equal((await admin('DELETE', '/app-releases/0.9.0')).status, 404)
  const audit = db.prepare("SELECT action,target,details FROM market_audit_events WHERE action LIKE 'app-release.%' ORDER BY id").all()
    .map(row => [row.action, row.target, JSON.parse(row.details)])
  assert.deepEqual(audit, [
    ['app-release.created', '0.8.0', {}],
    ['app-release.updated', '0.8.0', { status: 'draft', percent: 0, earlyCount: 1, holdCount: 0 }],
    ['app-release.updated', '0.8.0', { status: 'full', percent: 100, earlyCount: 1, holdCount: 0 }],
    ['app-release.created', '0.9.0', {}],
    ['app-release.deleted', '0.9.0', {}],
  ])
})

test('only the platform administrator: an organization administrator gets 403, nobody 401', async t => {
  const { env, admin, db } = fixture(t)
  const signed = await worker.fetch(new Request(`${ORIGIN}/api/v1/session`, { method: 'PUT', headers: { Origin: ORIGIN },
    body: JSON.stringify({ tokensapi: true, userId: 701, accessToken: 'tenant' }) }), env, {})
  assert.equal(signed.status, 200)
  const cookie = signed.headers.get('set-cookie').split(';')[0]
  for (const [method, path, data] of [['GET', '/app-releases'], ['POST', '/app-releases', { version: '0.8.0' }], ['GET', '/app-releases/available'],
    ['PATCH', '/app-releases/0.8.0', { percent: 1 }], ['DELETE', '/app-releases/0.8.0']]) {
    assert.equal((await admin(method, path, data, { Cookie: cookie })).status, 403, `${method} ${path}`)
    assert.equal((await admin(method, path, data, {})).status, 401, `${method} ${path}`)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_release_rollouts').get().n, 0)
})

test('the versions to pick from come from the GitHub release list; unreadable is a 503', async t => {
  const { admin } = fixture(t)
  const fetched = []
  t.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url))
    return Response.json([
      { tag_name: 'v0.7.18', prerelease: true, draft: false, published_at: '2026-11-18T11:13:53Z' },
      { tag_name: 'v0.7.19', prerelease: false, draft: false, published_at: '2026-11-21T15:52:12Z' },
      { tag_name: 'v0.8.0-rc.1', prerelease: true, draft: false },
      { tag_name: 'v0.8.0', prerelease: true, draft: true },
      { name: 'no tag' },
    ])
  })
  const { status, json } = await admin('GET', '/app-releases/available')
  assert.equal(status, 200)
  assert.deepEqual(fetched, [APP_RELEASES_URL])
  assert.deepEqual(json.items, [
    { version: '0.7.19', prerelease: false, publishedAt: '2026-11-21T15:52:12Z' },
    { version: '0.7.18', prerelease: true, publishedAt: '2026-11-18T11:13:53Z' },
  ])
  globalThis.fetch.mock.mockImplementation(async () => { throw new TypeError('fetch failed') })
  assert.equal((await admin('GET', '/app-releases/available')).status, 503)
})

// ── T0112: users on the lists, the single version, and what GitHub says about a version ─────────

test('user lists come before organization lists: user hold, user early, organization hold, organization early, the percentage', async t => {
  const { update, release } = fixture(t)
  // 501 (sk-seven) is in organization 7, 502 (sk-nine) in 9, 503 (sk-alone) in none.
  await release('0.8.0', { status: 'rolling', percent: 0, early: [9], hold: [7], earlyUsers: [501], holdUsers: [502] })
  // User early beats the organization's hold, at 0 % and outside the bucket.
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-seven', id: INSTALL.high })).json, { version: '0.8.0' })
  // User hold beats the organization's early list, and a manual check.
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-nine' })).json, { version: null })
  assert.deepEqual((await update('version=0.7.19&manual=1', { key: 'sk-nine' })).json, { version: null })
  // No Key: no user, no organization -- the percentage (0 %), on a manual check too.
  assert.deepEqual((await update('version=0.7.19', { id: INSTALL.low })).json, { version: null })
  assert.deepEqual((await update('version=0.7.19&manual=1', { id: INSTALL.low })).json, { version: null })
})

test('a held user gets nothing at 100 % or on a manual check; an early user without organization gets it at 0 %', async t => {
  const { update, release } = fixture(t)
  await release('0.8.0', { status: 'full', holdUsers: [503] })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-alone' })).json, { version: null })
  assert.deepEqual((await update('version=0.7.19&manual=1', { key: 'sk-alone' })).json, { version: null })
  // Everyone else, signed in or not, still gets it.
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-nine' })).json, { version: '0.8.0' })
  assert.deepEqual((await update('version=0.7.19')).json, { version: '0.8.0' })
  // Held from 0.8.0 only: a newer version they are early for reaches them at 0 %.
  await release('0.9.0', { status: 'rolling', percent: 0, earlyUsers: [503] })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-alone', id: INSTALL.high })).json, { version: '0.9.0' })
  assert.deepEqual((await update('version=0.7.19', { key: 'sk-nine', id: INSTALL.high })).json, { version: '0.8.0' })
})

test('user lists are checked: numbers, no duplicates, not on both lists, and a user that exists', async t => {
  const { db, env, admin, release } = fixture(t)
  await release('0.8.0')
  const patch = data => admin('PATCH', '/app-releases/0.8.0', data)
  assert.equal((await patch({ earlyUsers: ['501'] })).status, 400)
  assert.equal((await patch({ earlyUsers: [501, 501] })).status, 400)
  const both = await patch({ earlyUsers: [501], holdUsers: [501] })
  assert.deepEqual([both.status, both.json.error], [400, '同一个用户不能同时在先发和暂缓名单里'])
  const nobody = await patch({ earlyUsers: [404] })
  assert.deepEqual([nobody.status, nobody.json.error], [400, 'TokensAPI 中没有用户 #404'])
  const down = await patch({ holdUsers: [999] })
  assert.deepEqual([down.status, down.json.error], [503, '暂时无法向 TokensAPI 核对用户 #999，请稍后再试'])
  assert.equal((await patch({ earlyUsers: [501, 503], holdUsers: [502] })).status, 200)
  // The other list is checked against the one already saved; a move in one save is fine.
  assert.equal((await patch({ holdUsers: [501] })).status, 400)
  assert.equal((await patch({ earlyUsers: [503], holdUsers: [502, 501] })).status, 200)
  assert.deepEqual(db.prepare('SELECT user_id,kind FROM app_release_rollout_users ORDER BY user_id').all().map(r => [r.user_id, r.kind]),
    [[501, 'hold'], [502, 'hold'], [503, 'early']])
  // A user already on the lists is not asked about again, so a save works while TokensAPI is down.
  env.MARKET_ORGANIZATIONS.searchUsers = async () => { throw new Error('down') }
  assert.equal((await patch({ earlyUsers: [503, 501], holdUsers: [502] })).status, 200)
  // Without TokensAPI search, a directory user can be named and anyone else is refused, with the reason.
  db.exec("INSERT INTO market_users(id,name,created_at) VALUES(601,'Directory',0)")
  delete env.MARKET_ORGANIZATIONS.searchUsers
  assert.equal((await patch({ earlyUsers: [601] })).status, 200)
  const unknown = await patch({ earlyUsers: [602] })
  assert.deepEqual([unknown.status, unknown.json.error], [400, '用户 #602 不在「用户」名录里，且未配置 TokensAPI 用户搜索，无法核对'])
  // An organization and a user may share a number: the lists are separate.
  assert.equal((await patch({ early: [7], earlyUsers: [], holdUsers: [601] })).status, 200)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_release_rollout_users WHERE kind='early'").get().n, 0)
})

test('the list and one version carry the user lists with names; deleting a draft removes them; changes are audited by kind', async t => {
  const { db, admin, release } = fixture(t)
  db.exec("INSERT INTO market_users(id,name,created_at) VALUES(601,'目录用户',0)")
  await release('0.8.0', { status: 'rolling', percent: 20, early: [9], earlyUsers: [601, 501], holdUsers: [503] })
  const { json } = await admin('GET', '/app-releases')
  const [item] = json.items
  assert.deepEqual([item.early, item.hold], [[9], []])
  assert.deepEqual(item.earlyUsers, [{ id: 501, name: 'Owner', organization: { id: 7, name: 'Seven' } }, { id: 601, name: '目录用户' }])
  assert.deepEqual(item.holdUsers, [{ id: 503, name: 'Alone', organization: null }])
  const one = await admin('GET', '/app-releases/0.8.0')
  assert.equal(one.status, 200)
  assert.deepEqual({ ...one.json, installations: undefined }, { ...item, installations: undefined })
  assert.deepEqual(one.json.installations, json.installations)
  assert.equal((await admin('GET', '/app-releases/0.9.9')).status, 404)
  assert.equal((await admin('GET', '/app-releases/latest')).status, 404)
  const audit = db.prepare("SELECT details FROM market_audit_events WHERE action='app-release.updated'").all().map(row => JSON.parse(row.details))
  assert.deepEqual(audit, [{ status: 'rolling', percent: 20, earlyCount: 1, holdCount: 0, earlyUserCount: 2, holdUserCount: 1 }])
  await release('0.9.0', { earlyUsers: [501] })
  assert.equal((await admin('DELETE', '/app-releases/0.9.0')).status, 200)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_release_rollout_users WHERE version='0.9.0'").get().n, 0)
})

const RELEASE_LIST = JSON.parse(readFileSync(new URL('./fixtures/app-releases.json', import.meta.url), 'utf8'))

test('version information comes from the GitHub release list, as plain text, kept a few minutes', async t => {
  const { admin } = fixture(t)
  const fetched = []
  t.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url))
    return Response.json([...RELEASE_LIST, { tag_name: 'v0.9.0', draft: true, body: '# 草稿' }, { tag_name: 'v0.7.20', body: '重复的标签' }])
  })
  const brief = await admin('GET', '/app-releases/info')
  assert.equal(brief.status, 200)
  assert.deepEqual(brief.json.items.map(item => [item.version, item.prerelease, item.publishedAt]), [
    ['0.7.20', true, '2026-11-25T07:21:24Z'], ['0.7.19', false, '2026-11-21T15:52:12Z'], ['0.5.13', true, '2026-09-23T04:38:25Z']])
  assert.match(brief.json.items[0].summary, /^在 v0\.7\.19 基础上，更新提醒不再每次启动都弹窗/u)
  const full = await admin('GET', '/app-releases/0.7.20/info')
  assert.equal(full.status, 200)
  assert.equal(full.json.url, 'https://github.com/TokensAPI/TokensCowork/releases/tag/v0.7.20')
  assert.deepEqual(full.json.highlights.map(section => [section.title, section.items.length]), [['✨ 新功能与优化', 2], ['🐛 问题修复', 4], ['⚠️ 其他变更', 3]])
  // Markdown is reduced to text: no backticks, links or emphasis survive.
  assert.ok(full.json.highlights[1].items[0].includes('返回 content.some is not a function，现已修复'))
  assert.ok(!/[`*]|\]\(/u.test(JSON.stringify(full.json.highlights)))
  assert.deepEqual(full.json.components.slice(0, 3), [{ name: 'Desktop', version: '2.0.18' }, { name: 'DSH', version: '0.2.1-rc.2' }, { name: 'TokensCowork 更新', version: '0.2.0' }])
  assert.equal(full.json.components.length, 9)
  assert.deepEqual(full.json.installers.map(item => item.name), ['TokensCowork-0.7.20-macos-amd64-installer.dmg',
    'TokensCowork-0.7.20-macos-arm64-installer.dmg', 'TokensCowork-0.7.20-windows-amd64-installer.exe'])
  assert.equal(full.json.installers[2].size, 269606992)
  // Older notes: points straight under 本次更新, no components table.
  const old = (await admin('GET', '/app-releases/0.5.13/info')).json
  assert.deepEqual([old.highlights.length, old.highlights[0].title, old.highlights[0].items.length, old.components], [1, '', 3, []])
  assert.equal(old.summary, '内置 TokensAPI 账户插件，支持通过系统浏览器登录账户，并为模型插件配置账户所属的 API Key。')
  // Not on GitHub (a draft or never published), or not a version.
  const missing = await admin('GET', '/app-releases/0.9.0/info')
  assert.deepEqual([missing.status, missing.json.error], [404, 'GitHub 发布列表里没有 v0.9.0'])
  assert.equal((await admin('GET', '/app-releases/latest/info')).status, 400)
  // One read served all of it.
  assert.deepEqual(fetched, [APP_RELEASES_URL])
  // 新建版本's list is always read afresh.
  assert.equal((await admin('GET', '/app-releases/available')).status, 200)
  assert.equal(fetched.length, 2)
})

test('version information that cannot be read is a 503, and is asked for again next time', async t => {
  const { admin } = fixture(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    if (calls === 2) return new Response('busy', { status: 502 })
    return Response.json({ not: 'a list' })
  })
  for (const path of ['/app-releases/0.7.20/info', '/app-releases/info', '/app-releases/0.7.20/info']) {
    const { status, json } = await admin('GET', path)
    assert.deepEqual([status, json.error], [503, 'GitHub 发布列表暂时读不到'])
  }
  assert.equal(calls, 3)
  // The rollout list itself never needs GitHub.
  assert.equal((await admin('GET', '/app-releases')).status, 200)
  assert.equal(calls, 3)
})

test('the version information and single-version endpoints need the platform administrator', async t => {
  const { admin } = fixture(t)
  for (const path of ['/app-releases/info', '/app-releases/0.7.20/info', '/app-releases/0.7.20']) assert.equal((await admin('GET', path, undefined, {})).status, 401, path)
})
