import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import worker from '../_worker.js'
import { createAssets, createD1Database } from '../runtime/adapters.mjs'
import { createLocalObjectStore } from '../runtime/session-log-storage.mjs'
import { fingerprint } from '../security/key-fingerprint.js'
import { MIGRATIONS } from '../database/migrate.mjs'
import { purgeExpiredSessionLogs } from '../services/session-logs.js'

// Made-up sessions shaped like dsh_session_log batches (agent-hub/docs/session-log-upload-contract.md).
// No real user data: every id, path, Key and message here is fiction.
const ORIGIN = 'https://market.test'
const KEY = 'sk-fixture-session-log-key-0001'
const OTHER_KEY = 'sk-fixture-session-log-key-0002'
const SESSION_ID = 'session-11111111-2222-4333-8444-555555555555'
const CHILD_ID = 'session-66666666-7777-4888-9999-000000000000'
const CREATED = Date.UTC(2026, 9, 20, 8, 0, 0)

// onDisk keeps the index in a real file, for tests that read its bytes.
async function fixture(t, extra = {}, { onDisk = false } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'market-session-logs-'))
  const market = createD1Database(':memory:', MIGRATIONS)
  const index = createD1Database(onDisk ? resolve(dir, 'index.sqlite') : ':memory:', resolve(import.meta.dirname, '../database/session-log-migrations'))
  market.database.exec("INSERT INTO market_organizations(id,name,enabled) VALUES(7,'Seven',1)")
  t.after(async () => { market.close(); index.close(); await rm(dir, { recursive: true, force: true }) })
  const env = {
    MARKET_ADMIN_TOKEN: 'fixture-admin', MARKET_HMAC_SECRET: 'fixture-hmac', MARKET_KEY_ENCRYPTION_SECRET: 'fixture-vault',
    MARKET_DB: market, MARKET_SESSION_LOG_DB: index, MARKET_SESSION_LOG_STORE: createLocalObjectStore(resolve(dir, 'objects')),
    ASSETS: createAssets(resolve(fileURLToPath(new URL('..', import.meta.url)))),
    MARKET_ORGANIZATIONS: {
      resolveAccount: async c => (c.userId === 501 ? { id: 501, displayName: 'Owner' } : null),
      resolveMyOrg: async c => (c.userId === 501 ? { id: 7, name: 'Seven', role: 100 } : null),
    },
    ...extra,
  }
  const upload = (batch, { key = KEY, gzip = true, raw, headers = {} } = {}) => {
    const json = raw ?? Buffer.from(JSON.stringify(batch))
    return worker.fetch(new Request(ORIGIN + '/v1/session-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        ...(key ? { authorization: 'Bearer ' + key } : {}), 'cf-connecting-ip': '203.0.113.9', ...headers },
      body: gzip ? gzipSync(json) : json,
    }), env, {})
  }
  const api = async (path, { method = 'GET', data, cookie } = {}) => {
    const response = await worker.fetch(new Request(ORIGIN + '/api/v1' + path, {
      method,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : { authorization: 'Bearer fixture-admin' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }), env, {})
    return { status: response.status, json: await response.json() }
  }
  const rows = sql => index.database.prepare(sql).all().map(row => ({ ...row }))
  const objects = () => env.MARKET_SESSION_LOG_STORE.list('session-logs/')
  return { env, dir, market, index, upload, api, rows, objects }
}

const event = (seq, type = 'user/message', data = { content: [{ type: 'text', text: `message ${seq}` }] }) =>
  ({ seq, time: CREATED + seq * 1000, type, data })
function batch(events, { id = SESSION_ID, afterSeq = events[0].seq - 1, session = {}, account = { id: '9001' } } = {}) {
  return {
    version: 1, sessionFormatVersion: 4,
    session: { id, createdAt: CREATED, cwd: 'C:\\fixture\\project', ...session },
    afterSeq, throughSeq: events.at(-1).seq, events,
    client: { product: 'TokensCowork', version: '0.7.8', platform: 'win32' },
    ...(account ? { account } : {}),
  }
}
const selfTest = {
  version: 1, sessionFormatVersion: 4, session: { id: 'session-selftest', createdAt: 1793318400000 }, afterSeq: -1, throughSeq: 0,
  events: [{ seq: 0, time: 1793318400000, type: 'user/message', data: { text: 'hello' } }],
  client: { product: 'TokensCowork', version: 'selftest', platform: 'win32' },
}

test('the contract self-test request sent twice is accepted twice and stored once', async t => {
  const { upload, rows, objects } = await fixture(t)
  for (let i = 0; i < 2; i++) {
    const response = await upload(selfTest, { headers: { 'idempotency-key': 'session-selftest:-1:0' } })
    assert.equal(response.status, 200)
  }
  assert.equal(rows('SELECT * FROM session_log_events').length, 1)
  assert.deepEqual(await objects(), ['session-logs/2026/10/session-selftest/4/-1-0.json.gz'])
  assert.equal(rows('SELECT event_count FROM session_log_sessions')[0].event_count, 1)
})

test('overlapping batches store only the events not seen before', async t => {
  const { upload, rows, objects, env } = await fixture(t)
  assert.equal((await upload(batch([event(0), event(1), event(2)]))).status, 200)
  const response = await upload(batch([event(1), event(2), event(3), event(4)], { afterSeq: 0 }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, stored: 2, duplicates: 2 })
  assert.deepEqual(rows('SELECT seq FROM session_log_events ORDER BY seq').map(row => row.seq), [0, 1, 2, 3, 4])
  const keys = await objects()
  assert.equal(keys.length, 2)
  const second = JSON.parse(gunzipSync(await env.MARKET_SESSION_LOG_STORE.get(keys.find(key => key.endsWith('/2-4.json.gz')))))
  assert.deepEqual(second.events.map(item => item.seq), [3, 4])
})

test('a gap is accepted and counted as missing events', async t => {
  const { upload, api } = await fixture(t)
  await upload(batch([event(0), event(1)]))
  assert.equal((await upload(batch([event(5), event(6)], { afterSeq: 4 }))).status, 200)
  const { json } = await api('/session-logs')
  assert.equal(json.items[0].eventCount, 4)
  assert.equal(json.items[0].maxSeq, 6)
  assert.equal(json.items[0].missingEvents, 3)
})

test('unknown event types and fields are stored as they came', async t => {
  const { upload, api } = await fixture(t)
  const odd = { seq: 0, time: CREATED, type: 'future/kind', data: { nested: { anything: [1, 2] } }, ignorable: true, extra: 'kept' }
  assert.equal((await upload({ ...batch([odd]), somethingNew: { a: 1 } })).status, 200)
  const { json } = await api(`/session-logs/${SESSION_ID}/4`)
  assert.deepEqual(json.events, [odd])
})

test('an upload without a Key is stored as anonymous, never refused with 401', async t => {
  const { upload, api, rows } = await fixture(t)
  const response = await upload(batch([event(0)], { account: null }), { key: null })
  assert.equal(response.status, 200)
  assert.deepEqual(rows('SELECT key_fingerprint,account_id FROM session_log_sessions'), [{ key_fingerprint: null, account_id: null }])
  assert.equal((await api('/session-logs?anonymous=true')).json.total, 1)
  // A malformed Authorization header is not a credential either; it still uploads as anonymous.
  assert.equal((await upload(batch([event(1)]), { key: null, headers: { authorization: 'Basic abc' } })).status, 200)
})

test('oversized, malformed and flooding uploads get 413, 400 and 429', async t => {
  const { upload, rows, env } = await fixture(t, { MARKET_SESSION_LOG_RATE_PER_MINUTE: '6' })
  // A tiny gzip body that inflates past 8 MiB is refused without being held in memory whole.
  const bomb = Buffer.from(JSON.stringify(batch([event(0, 'user/message', { text: 'x'.repeat(9 * 1024 * 1024) })])))
  assert.ok(gzipSync(bomb).length < 64 * 1024)
  assert.equal((await upload(null, { raw: bomb })).status, 413)
  assert.equal((await upload(null, { raw: Buffer.from('{not json') })).status, 400)
  assert.equal((await upload({ ...batch([event(0)]), session: { createdAt: CREATED } })).status, 400)
  assert.equal((await upload(null, { raw: Buffer.from('not gzip at all'), gzip: false, headers: { 'content-encoding': 'gzip' } })).status, 400)
  assert.equal(rows('SELECT * FROM session_log_sessions').length, 0)
  // Six requests per minute for this Key in this fixture; the seventh waits.
  assert.equal((await upload(batch([event(0)]))).status, 200)
  assert.equal((await upload(batch([event(1)]))).status, 200)
  const limited = await upload(batch([event(2)]))
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)
  // Another Key has its own budget, and the catalog is not rate limited at all.
  assert.equal((await upload(batch([event(2)]), { key: OTHER_KEY })).status, 200)
  const catalog = await worker.fetch(new Request(ORIGIN + '/v1/plugins', { headers: { authorization: 'Bearer ' + KEY } }), env, {})
  assert.equal(catalog.status, 200)
})

// Every byte the index has on disk: the database file and its write-ahead log.
const indexBytes = async dir => Buffer.concat(await Promise.all(['index.sqlite', 'index.sqlite-wal']
  .map(name => readFile(resolve(dir, name)).catch(() => Buffer.alloc(0)))))

test('the Key is stored only sealed: never plain in the index file, the objects, the activity log or the console output', async t => {
  const { upload, api, rows, objects, env, market, dir } = await fixture(t, {}, { onDisk: true })
  const printed = []
  for (const name of ['log', 'error', 'warn', 'info']) t.mock.method(console, name, (...args) => printed.push(args.join(' ')))
  await upload(batch([event(0), event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'hi' }], source: { model: 'fixture-model' } },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })]))
  await upload(batch([event(2)], { afterSeq: 1 }))
  await upload(batch([event(0)], { id: CHILD_ID }), { key: OTHER_KEY })
  await upload(null, { raw: Buffer.from('{broken') })
  const detail = (await api(`/session-logs/${SESSION_ID}/4`)).json
  // The fingerprint is stable and still keys the session; the Key itself is a ciphertext.
  const fingerprints = rows('SELECT session_id,key_fingerprint FROM session_log_sessions ORDER BY session_id')
  assert.deepEqual(fingerprints.map(row => row.key_fingerprint),
    [await fingerprint(KEY, 'fixture-hmac'), await fingerprint(OTHER_KEY, 'fixture-hmac')])
  const sealed = rows('SELECT encrypted_key FROM session_log_keys').map(row => row.encrypted_key)
  assert.equal(sealed.length, 2)
  for (const value of sealed) assert.match(value, /^[a-f0-9]{24}\.[a-f0-9]+$/u)
  // The console gets the Key back in full.
  assert.equal(detail.session.key, KEY)
  assert.equal(detail.keyDisplayReady, true)

  const stored = Buffer.concat([
    await indexBytes(dir),
    Buffer.from(JSON.stringify(market.database.prepare('SELECT * FROM market_audit_events').all())),
    ...await Promise.all((await objects()).map(async key => gunzipSync(await env.MARKET_SESSION_LOG_STORE.get(key)))),
    Buffer.from(printed.join('\n')),
  ])
  assert.ok(stored.length > 4096, 'the index file was read')
  for (const secret of [KEY, OTHER_KEY, KEY.slice(3)]) assert.ok(!stored.includes(secret), 'raw Key found in storage')
})

test('without MARKET_KEY_ENCRYPTION_SECRET the Key is not kept at all, and uploads go on', async t => {
  const { upload, api, rows, dir } = await fixture(t, { MARKET_KEY_ENCRYPTION_SECRET: '' }, { onDisk: true })
  assert.equal((await upload(batch([event(0)]))).status, 200)
  assert.deepEqual(rows('SELECT key_fingerprint,encrypted_key FROM session_log_keys'),
    [{ key_fingerprint: await fingerprint(KEY, 'fixture-hmac'), encrypted_key: null }])
  const list = (await api('/session-logs')).json
  assert.equal(list.keyDisplayReady, false)
  assert.equal(list.items[0].key, null)
  assert.equal(list.items[0].keyFingerprint, await fingerprint(KEY, 'fixture-hmac'))
  const detail = (await api(`/session-logs/${SESSION_ID}/4`)).json
  assert.deepEqual(detail.keys.map(item => [item.key, item.fingerprint]), [[null, await fingerprint(KEY, 'fixture-hmac')]])
  // The full Key still finds its sessions through the fingerprint.
  assert.equal((await api('/session-logs?key=' + KEY)).json.total, 1)
  assert.ok(!(await indexBytes(dir)).includes(KEY), 'raw Key found in the index file')
})

test('a session uploaded with two Keys lists both; the list shows the latest and either one finds it', async t => {
  const { upload, api } = await fixture(t)
  await upload(batch([event(0)]))
  await upload(batch([event(1)]), { key: OTHER_KEY })
  await upload(batch([event(0)], { id: CHILD_ID }), { key: OTHER_KEY })
  const list = (await api('/session-logs')).json
  assert.equal(list.items.find(item => item.id === SESSION_ID).key, OTHER_KEY)
  const detail = (await api(`/session-logs/${SESSION_ID}/4`)).json
  assert.deepEqual(detail.keys.map(item => item.key), [KEY, OTHER_KEY])
  for (const item of detail.keys) assert.ok(item.firstUsedAt > 0 && item.lastUsedAt >= item.firstUsedAt)
  // Filter by the whole Key, by its beginning, or by a fingerprint prefix: any Key the session used counts.
  for (const [query, expected] of [[KEY, [SESSION_ID]], [OTHER_KEY, [SESSION_ID, CHILD_ID]], ['sk-fixture-session-log-key-000', [SESSION_ID, CHILD_ID]],
    [(await fingerprint(KEY, 'fixture-hmac')).slice(0, 12), [SESSION_ID]], ['sk-nobody', []]]) {
    const found = (await api('/session-logs?key=' + encodeURIComponent(query))).json.items.map(item => item.id).sort()
    assert.deepEqual(found, expected, query)
  }
})

test('only the platform administrator reads, deletes or configures session logs', async t => {
  const { upload, api, market, env } = await fixture(t)
  await upload(batch([event(0)]))
  // An organization administrator of an organization registered and enabled here.
  const login = await worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { origin: ORIGIN },
    body: JSON.stringify({ tokensapi: true, accessToken: 'owner', userId: 501 }) }), env, {})
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const probes = [
    ['GET', '/session-logs'], ['DELETE', '/session-logs', { to: Date.now() }], ['GET', '/session-logs/settings'],
    ['PUT', '/session-logs/settings', { retentionDays: 1 }], ['GET', `/session-logs/${SESSION_ID}/4`], ['DELETE', `/session-logs/${SESSION_ID}/4`],
    ['GET', `/session-logs/${SESSION_ID}/4/raw`], ['GET', `/session-logs/${SESSION_ID}/4/raw?format=jsonl`],
  ]
  for (const [method, path, data] of probes) assert.equal((await api(path, { method, data, cookie })).status, 403, `${method} ${path}`)
  assert.equal(market.database.prepare("SELECT COUNT(*) AS n FROM market_audit_events WHERE action LIKE 'session-log.%'").get().n, 0)
  assert.equal((await api('/session-logs')).status, 200)
  // Opening a session is itself recorded: who, when, which session.
  assert.equal((await api(`/session-logs/${SESSION_ID}/4`)).status, 200)
  const viewed = (await api('/audit')).json.items.find(item => item.action === 'session-log.viewed')
  assert.deepEqual([viewed.target, viewed.actor.kind], [`${SESSION_ID}:4`, 'root'])
  assert.ok(viewed.createdAt > 0)
})

test('upload, list and replay a session with a sub-agent, then find the parent from the child', async t => {
  const { upload, api, market } = await fixture(t)
  market.database.prepare("INSERT INTO market_keys(fingerprint,label,created_at) VALUES(?,'客户 A 测试 Key',0)").run(await fingerprint(KEY, 'fixture-hmac'))
  await upload(batch([
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', { content: [{ type: 'text', text: '帮我看看 README' }] }),
    event(2, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先读文件' }, { type: 'text', text: '好的' }],
      source: { kind: 'llm', provider: 'tokensapi', model: 'fixture-model-a' } }, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
  ]))
  await upload(batch([
    event(3, 'tool/call', { turn: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }),
    event(4, 'tool/result', { turn: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '# Fixture' }], isError: false } }),
    event(5, 'model/selection', { provider: 'tokensapi', model: 'fixture-model-b' }),
    event(6, 'session/title', { title: '阅读 README' }),
  ], { afterSeq: 2 }))
  await upload(batch([event(0)], { id: CHILD_ID, account: null, session: { parentSession: SESSION_ID, delegationDepth: 1 } }), { key: null })

  const list = (await api('/session-logs')).json
  assert.equal(list.total, 2)
  const parent = list.items.find(item => item.id === SESSION_ID)
  assert.equal(parent.title, '阅读 README')
  assert.equal(parent.keyLabel, '客户 A 测试 Key')
  assert.equal(parent.accountId, '9001')
  assert.deepEqual(parent.models, ['fixture-model-a', 'fixture-model-b'])
  assert.deepEqual(parent.tokens, { input: 100, output: 20, total: 120 })
  assert.deepEqual(parent.client, { product: 'TokensCowork', version: '0.7.8', platform: 'win32' })
  assert.equal(parent.key, KEY)
  // Filters: account, Key, client version, model and time all narrow the index.
  for (const [query, expected] of [['account=9001', 1], [`key=${KEY.slice(0, 12)}`, 1], ['key=not-a-key', 0], ['clientVersion=0.7.8', 2],
    ['clientVersion=0.6.0', 0], ['model=fixture-model-b', 1], [`from=${CREATED + 1}`, 0], [`to=${CREATED + 1}`, 2], [`session=${SESSION_ID}`, 1]])
    assert.equal((await api('/session-logs?' + query)).json.total, expected, query)
  assert.equal((await api('/session-logs?key=' + 'k'.repeat(301))).status, 400)

  // Replay reads the events back from both objects, in seq order, page by page.
  const first = (await api(`/session-logs/${SESSION_ID}/4?limit=4`)).json
  assert.deepEqual(first.events.map(item => item.type), ['turn/start', 'user/message', 'assistant/message', 'tool/call'])
  assert.equal(first.next, 3)
  const rest = (await api(`/session-logs/${SESSION_ID}/4?after=3`)).json
  assert.deepEqual(rest.events.map(item => item.seq), [4, 5, 6])
  assert.equal(rest.next, null)
  const child = (await api(`/session-logs/${CHILD_ID}/4`)).json.session
  assert.equal(child.parentSession, SESSION_ID)
  assert.deepEqual([child.key, child.keyFingerprint], [null, null])
  assert.deepEqual((await api(`/session-logs/${CHILD_ID}/4`)).json.keys, [])
  assert.equal((await api(`/session-logs?session=${child.parentSession}`)).json.items[0].formatVersion, 4)
  assert.equal((await api('/session-logs/session-none/4')).status, 404)
})

test('retention: forever by default, N days when set; manual deletion of one session or a time range is recorded', async t => {
  const { upload, api, rows, objects, env } = await fixture(t)
  for (const [index, id] of ['session-a', 'session-b', 'session-c'].entries())
    await upload(batch([event(0)], { id, session: { createdAt: CREATED + index * 1000 } }))
  env.MARKET_SESSION_LOG_DB.database.prepare("UPDATE session_log_sessions SET last_received_at=? WHERE session_id='session-a'").run(Date.now() - 10 * 86400000)
  assert.deepEqual((await api('/session-logs/settings')).json, { retentionDays: null })
  assert.equal(await purgeExpiredSessionLogs(env), 0)
  assert.equal(rows('SELECT * FROM session_log_sessions').length, 3)

  assert.equal((await api('/session-logs/settings', { method: 'PUT', data: { retentionDays: 0 } })).status, 400)
  assert.deepEqual((await api('/session-logs/settings', { method: 'PUT', data: { retentionDays: 7 } })).json, { retentionDays: 7 })
  assert.equal(await purgeExpiredSessionLogs(env), 1)
  assert.deepEqual(rows('SELECT session_id FROM session_log_sessions ORDER BY session_id').map(row => row.session_id), ['session-b', 'session-c'])
  assert.equal(rows("SELECT * FROM session_log_events WHERE session_id='session-a'").length, 0)
  assert.ok(!(await objects()).some(key => key.includes('/session-a/')))

  assert.equal((await api('/session-logs/session-b/4', { method: 'DELETE' })).json.count, 1)
  assert.equal((await api('/session-logs', { method: 'DELETE', data: { from: CREATED + 2000, to: CREATED + 3000 } })).json.count, 1)
  assert.equal((await api('/session-logs', { method: 'DELETE', data: { from: 5, to: 5 } })).status, 400)
  assert.deepEqual(rows('SELECT * FROM session_log_sessions'), [])
  assert.deepEqual(await objects(), [])
  assert.deepEqual((await api('/session-logs/settings', { method: 'PUT', data: { retentionDays: null } })).json, { retentionDays: null })
  const actions = (await api('/audit')).json.items.map(item => [item.action, item.target, item.details])
  assert.deepEqual(actions.filter(([action]) => action.startsWith('session-log.')).reverse(), [
    ['session-log.settings', 'retention', { retentionDays: 7 }],
    ['session-log.purged', 'retention', { count: 1, retentionDays: 7 }],
    ['session-log.deleted', 'session-b:4', { count: 1 }],
    ['session-log.deleted', 'range', { count: 1, from: CREATED + 2000, to: CREATED + 3000 }],
    ['session-log.settings', 'retention', { retentionDays: null }],
  ])
})

test('session logs answer 503 rather than guessing when no store is configured', async t => {
  const { env, api } = await fixture(t)
  delete env.MARKET_SESSION_LOG_STORE
  const response = await worker.fetch(new Request(ORIGIN + '/v1/session-logs', { method: 'POST', body: gzipSync('{}'),
    headers: { 'content-encoding': 'gzip' } }), env, {})
  assert.equal(response.status, 503)
  assert.equal((await api('/session-logs')).status, 503)
  assert.equal((await worker.fetch(new Request(ORIGIN + '/v1/session-logs'), env, {})).status, 405)
})

test('the whole session downloads as JSON and JSON Lines, merged by seq, and every download is recorded', async t => {
  const { env, upload, api, market } = await fixture(t)
  const download = async (path, cookie) => {
    const response = await worker.fetch(new Request(ORIGIN + '/api/v1' + path, {
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : { authorization: 'Bearer fixture-admin' }) } }), env, {})
    return { status: response.status, headers: response.headers, text: await response.text() }
  }
  // Two overlapping batches and a gap: seq 0-3, then 2-5, then 8.
  await upload(batch([0, 1, 2, 3].map(seq => event(seq))))
  await upload(batch([2, 3, 4, 5].map(seq => event(seq)), { account: { id: '9002' } }))
  await upload(batch([event(8, 'future/unknown-kind', { anything: true })]))

  const json = await download(`/session-logs/${SESSION_ID}/4/raw`)
  assert.equal(json.status, 200)
  assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(json.headers.get('content-disposition'), `attachment; filename="${SESSION_ID}.json"`)
  const whole = JSON.parse(json.text)
  assert.deepEqual(Object.keys(whole), ['version', 'sessionFormatVersion', 'session', 'client', 'account', 'events'])
  assert.deepEqual(whole.events.map(item => item.seq), [0, 1, 2, 3, 4, 5, 8])
  assert.deepEqual(whole.events[6], event(8, 'future/unknown-kind', { anything: true }))
  assert.equal(whole.session.id, SESSION_ID)
  // The header is the newest upload's, the same the detail's first page carries.
  const first = (await api(`/session-logs/${SESSION_ID}/4?limit=2`)).json
  assert.deepEqual(first.header, { version: 1, sessionFormatVersion: 4, session: whole.session, client: whole.client, account: whole.account })
  const second = (await api(`/session-logs/${SESSION_ID}/4?after=${first.next}&limit=2`)).json
  assert.equal('header' in second, false)
  // The console builds its raw view from the detail pages; it must be byte-for-byte this file.
  const { rawDocument } = await import('../admin/assets/market-session-log-replay.js')
  const pages = [...first.events, ...second.events, ...(await api(`/session-logs/${SESSION_ID}/4?after=${second.next}`)).json.events]
  assert.equal(rawDocument(first.header, pages, 4, SESSION_ID), json.text)

  const lines = await download(`/session-logs/${SESSION_ID}/4/raw?format=jsonl`)
  assert.equal(lines.status, 200)
  assert.equal(lines.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  assert.equal(lines.headers.get('content-disposition'), `attachment; filename="${SESSION_ID}.jsonl"`)
  assert.deepEqual(lines.text.trimEnd().split('\n').map(line => JSON.parse(line)), whole.events)

  assert.equal((await download(`/session-logs/${SESSION_ID}/4/raw?format=xml`)).status, 400)
  assert.equal((await download('/session-logs/session-none/4/raw')).status, 404)
  assert.equal((await download(`/session-logs/${SESSION_ID}/4/raw/extra`)).status, 404)

  // Opening the session is one read however many pages it takes; each download is its own record.
  const audit = market.database.prepare("SELECT action,target,details FROM market_audit_events WHERE action LIKE 'session-log.%' ORDER BY id").all()
    .map(row => [row.action, row.target, JSON.parse(row.details)])
  assert.deepEqual(audit, [
    ['session-log.downloaded', `${SESSION_ID}:4`, { format: 'json' }],
    ['session-log.viewed', `${SESSION_ID}:4`, {}],
    ['session-log.downloaded', `${SESSION_ID}:4`, { format: 'jsonl' }],
  ])
  // A missing raw object leaves the index's placeholder in the download, as in the detail.
  for (const key of await env.MARKET_SESSION_LOG_STORE.list('session-logs/')) if (key.endsWith('/7-8.json.gz')) await env.MARKET_SESSION_LOG_STORE.delete(key)
  const after = JSON.parse((await download(`/session-logs/${SESSION_ID}/4/raw`)).text)
  assert.deepEqual(after.events.at(-1), { seq: 8, time: CREATED + 8000, type: 'future/unknown-kind', unavailable: true })
})

// ── Console management: paging, filters, deletion, notes (T0072) ─────────────────────────────

const sessionsOf = json => json.items.map(item => item.id)
async function seedMany(upload, count) {
  for (let i = 0; i < count; i++) {
    const id = `session-page-${String(i).padStart(2, '0')}`
    await upload(batch([event(0)], { id, account: { id: String(9000 + (i % 3)) }, session: { createdAt: CREATED + i * 3600000 } }))
  }
}

test('the list pages on the server: page size, total, a page past the end and filters kept across pages', async t => {
  const { upload, api } = await fixture(t)
  await seedMany(upload, 25)
  const first = (await api('/session-logs?pageSize=10')).json
  assert.deepEqual([first.total, first.page, first.pageSize, first.items.length], [25, 1, 10, 10])
  const second = (await api('/session-logs?pageSize=10&page=2')).json
  const third = (await api('/session-logs?pageSize=10&page=3')).json
  assert.equal(third.items.length, 5)
  // Every session exactly once across the pages.
  assert.equal(new Set([...sessionsOf(first), ...sessionsOf(second), ...sessionsOf(third)]).size, 25)
  // A page past the end comes back as the last page, not an empty one.
  const beyond = (await api('/session-logs?pageSize=10&page=9')).json
  assert.deepEqual([beyond.page, sessionsOf(beyond)], [3, sessionsOf(third)])
  assert.deepEqual((await api('/session-logs?account=nobody&page=4')).json.page, 1)
  for (const bad of ['pageSize=7', 'pageSize=1000', 'pageSize=abc', 'page=0', 'page=1.5'])
    assert.equal((await api('/session-logs?' + bad)).status, 400, bad)
  // The default is 50 per page, as before.
  assert.equal((await api('/session-logs')).json.pageSize, 50)
  // Filters narrow the total, and paging inside a filter keeps it.
  const filtered = (await api('/session-logs?account=9001&pageSize=10&page=1')).json
  assert.equal(filtered.total, 8)
  const filteredNext = (await api('/session-logs?account=9001&pageSize=10&page=2')).json
  assert.deepEqual([filteredNext.page, filteredNext.items.length], [1, 8])
})

test('filters: account, creation-time range, session id and tag', async t => {
  const { upload, api } = await fixture(t)
  await seedMany(upload, 6)
  const total = async query => (await api('/session-logs?' + query)).json.total
  assert.equal(await total('account=9002'), 2)
  assert.equal(await total(`from=${CREATED + 2 * 3600000}&to=${CREATED + 4 * 3600000}`), 2)
  assert.equal(await total(`account=9000&from=${CREATED}&to=${CREATED + 3600000}`), 1)
  assert.equal(await total('session=session-page-03'), 1)
  assert.equal(await total('session=session-page'), 0)
  assert.equal((await api('/session-logs?session=' + encodeURIComponent('bad id'))).status, 400)
  assert.equal((await api('/session-logs?from=yesterday')).status, 400)
  await api('/session-logs/session-page-04/4', { method: 'PATCH', data: { tags: ['回归', '待跟进'] } })
  assert.deepEqual(sessionsOf((await api('/session-logs?tag=' + encodeURIComponent('待跟进'))).json), ['session-page-04'])
  assert.equal(await total('tag=' + encodeURIComponent('待')), 0)
})

test('a batch delete removes the ticked sessions, objects and index, and records each one', async t => {
  const { upload, api, rows, objects } = await fixture(t)
  await seedMany(upload, 5)
  const response = await api('/session-logs', { method: 'DELETE', data: { sessions: [
    { id: 'session-page-01', formatVersion: 4 }, { id: 'session-page-03', formatVersion: 4 },
    { id: 'session-page-03', formatVersion: 4 }, { id: 'session-gone', formatVersion: 4 },
  ] } })
  assert.deepEqual([response.status, response.json], [200, { ok: true, count: 2, missing: 1 }])
  assert.deepEqual(rows('SELECT session_id FROM session_log_sessions ORDER BY session_id').map(row => row.session_id),
    ['session-page-00', 'session-page-02', 'session-page-04'])
  assert.equal(rows("SELECT * FROM session_log_events WHERE session_id IN ('session-page-01','session-page-03')").length, 0)
  assert.ok(!(await objects()).some(key => /session-page-0[13]/u.test(key)))
  const deleted = (await api('/audit')).json.items.filter(item => item.action === 'session-log.deleted').map(item => item.target).sort()
  assert.deepEqual(deleted, ['session-page-01:4', 'session-page-03:4'])
  for (const data of [{ sessions: [] }, { sessions: 'session-page-00' }, { sessions: [{ id: 'bad id', formatVersion: 4 }] },
    { sessions: [{ id: 'session-page-00', formatVersion: -1 }] },
    { sessions: Array.from({ length: 101 }, (_, i) => ({ id: `session-x-${i}`, formatVersion: 4 })) }])
    assert.equal((await api('/session-logs', { method: 'DELETE', data })).status, 400, JSON.stringify(data).slice(0, 60))
  assert.equal(rows('SELECT * FROM session_log_sessions').length, 3)
})

test('a note and tags are kept on the session, survive later uploads, and the note text stays out of the activity log', async t => {
  const { upload, api, rows } = await fixture(t)
  await upload(batch([event(0)]))
  const path = `/session-logs/${SESSION_ID}/4`
  const saved = await api(path, { method: 'PATCH', data: { note: '  用户反馈卡顿，复现中  ', tags: ['卡顿', ' 卡顿 ', '0.7.13'] } })
  assert.equal(saved.status, 200)
  assert.deepEqual([saved.json.note, saved.json.tags], ['用户反馈卡顿，复现中', ['卡顿', '0.7.13']])
  assert.ok(saved.json.annotatedAt > 0)
  // A later batch of the same session leaves the note alone, and the log content is untouched.
  await upload(batch([event(1)], { afterSeq: 0 }))
  const item = (await api('/session-logs')).json.items[0]
  assert.deepEqual([item.note, item.tags, item.eventCount], ['用户反馈卡顿，复现中', ['卡顿', '0.7.13'], 2])
  assert.equal((await api(path)).json.session.note, '用户反馈卡顿，复现中')
  // Tags alone keep the note; an empty note clears it.
  assert.deepEqual((await api(path, { method: 'PATCH', data: { tags: [] } })).json.note, '用户反馈卡顿，复现中')
  assert.deepEqual((await api(path, { method: 'PATCH', data: { note: '' } })).json, { note: null, tags: [], annotatedAt: rows('SELECT annotated_at FROM session_log_sessions')[0].annotated_at })
  for (const data of [{}, { note: 5 }, { note: 'x'.repeat(2001) }, { tags: 'a,b' }, { tags: ['a,b'] }, { tags: [''] }, { tags: ['x'.repeat(33)] },
    { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }])
    assert.equal((await api(path, { method: 'PATCH', data })).status, 400, JSON.stringify(data).slice(0, 60))
  assert.equal((await api('/session-logs/session-none/4', { method: 'PATCH', data: { note: 'x' } })).status, 404)
  const annotated = (await api('/audit')).json.items.filter(item => item.action === 'session-log.annotated')
  assert.deepEqual(annotated.map(item => item.details).reverse(), [
    { tags: ['卡顿', '0.7.13'], note: true }, { tags: [], note: true }, { tags: [], note: false },
  ])
  assert.ok(!JSON.stringify(annotated).includes('复现中'))
})

test('writes need a signed-in platform administrator: anonymous 401, organization administrator 403, foreign origin 403', async t => {
  const { upload, api, env, rows } = await fixture(t)
  await upload(batch([event(0)]))
  const writes = [
    ['PATCH', `/session-logs/${SESSION_ID}/4`, { note: 'x' }], ['DELETE', `/session-logs/${SESSION_ID}/4`],
    ['DELETE', '/session-logs', { sessions: [{ id: SESSION_ID, formatVersion: 4 }] }], ['DELETE', '/session-logs', { to: Date.now() }],
    ['GET', '/session-logs'],
  ]
  for (const [method, path, data] of writes) {
    const response = await worker.fetch(new Request(ORIGIN + '/api/v1' + path, { method, headers: { origin: ORIGIN },
      ...(data ? { body: JSON.stringify(data) } : {}) }), env, {})
    assert.equal(response.status, 401, `anonymous ${method} ${path}`)
  }
  const login = await worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { origin: ORIGIN },
    body: JSON.stringify({ tokensapi: true, accessToken: 'owner', userId: 501 }) }), env, {})
  const tenant = login.headers.get('set-cookie').split(';')[0]
  for (const [method, path, data] of writes) assert.equal((await api(path, { method, data, cookie: tenant })).status, 403, `tenant ${method} ${path}`)
  // The platform administrator's console cookie, but the write comes from another site.
  const root = await worker.fetch(new Request(ORIGIN + '/api/v1/session', { method: 'PUT', headers: { origin: ORIGIN },
    body: JSON.stringify({ credential: 'fixture-admin' }) }), env, {})
  const cookie = root.headers.get('set-cookie').split(';')[0]
  const foreign = await worker.fetch(new Request(ORIGIN + `/api/v1/session-logs/${SESSION_ID}/4`, { method: 'PATCH',
    headers: { origin: 'https://evil.test', cookie }, body: JSON.stringify({ note: 'x' }) }), env, {})
  assert.equal(foreign.status, 403)
  assert.deepEqual(rows('SELECT note FROM session_log_sessions'), [{ note: null }])
  assert.equal((await api(`/session-logs/${SESSION_ID}/4`, { method: 'PATCH', data: { note: 'ok' }, cookie })).status, 200)
})
