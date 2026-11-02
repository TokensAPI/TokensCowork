import { reply } from '../http/response.js'
import { bearer } from '../http/request.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { openKey, sealKey } from '../security/key-vault.js'
import { auditStatements } from './audit.js'
import { invalid } from './plugins.js'

// Session logs uploaded by the built-in @tokensapi/dsh-session-log plugin
// (agent-hub/docs/session-log-upload-contract.md). Two bindings carry them:
//   MARKET_SESSION_LOG_STORE — raw batches, one gzip object per accepted batch (see
//                              runtime/session-log-storage.mjs for the contract);
//   MARKET_SESSION_LOG_DB    — the index, a SQLite file of its own.
// Nobody is looked up anywhere: the uploader is identified only by the account id the client
// reports (unverified) and the Bearer Key. The index keys sessions by the Key's keyed fingerprint
// and keeps the Key itself only sealed with MARKET_KEY_ENCRYPTION_SECRET, so the console can show
// it; without that secret the Key is not kept at all. It is never logged or written to an object.
// The logs are not redacted, so only the platform administrator reads them, and every read is
// written to the activity log.

const MiB = 1024 * 1024
/** Uncompressed JSON per request, as the contract promises the client. */
export const SESSION_LOG_JSON_LIMIT = 8 * MiB
/** Compressed body per request. Incompressible gzip is a little larger than its input. */
export const SESSION_LOG_BODY_LIMIT = SESSION_LOG_JSON_LIMIT + MiB / 2
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/u
const FINGERPRINT_PREFIX = /^[a-f0-9]{4,64}$/u
/** Bound into the AES-GCM associated data, so a sealed session-log Key opens only as one. */
const SEALED_FOR = 'session-log'
const PAGE_SIZE = 50
const DEFAULT_RATE = 120
const DAY = 24 * 60 * 60 * 1000

const configured = env => Boolean(env.MARKET_SESSION_LOG_DB && env.MARKET_SESSION_LOG_STORE && env.MARKET_HMAC_SECRET)
const clip = (value, max = 200) => (typeof value === 'string' && value.length ? value.slice(0, max) : null)
const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0)
const sizedError = (message, status) => Object.assign(new Error(message), { status })

async function readLimited(stream, limit) {
  const reader = stream.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw sizedError('too large', 413)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

// Inflating stops at the limit, so a small bomb cannot expand into memory.
async function gunzip(bytes, limit) {
  try {
    return await readLimited(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), limit)
  } catch (error) {
    if (error.status === 413) throw error
    throw sizedError('invalid gzip', 400)
  }
}
const gzip = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())

// ── Upload ───────────────────────────────────────────────────────────────────

// A fixed one-minute window per Key fingerprint, or per source address for anonymous uploads.
// Held in memory: it only has to blunt a flood, and one process owns the data volume.
const windows = new WeakMap()
function rateWait(env, bucket, now) {
  const configuredLimit = Number(env.MARKET_SESSION_LOG_RATE_PER_MINUTE)
  const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : DEFAULT_RATE
  let buckets = windows.get(env)
  if (!buckets) windows.set(env, (buckets = new Map()))
  const window = Math.floor(now / 60000)
  if (buckets.size > 10000) for (const [name, entry] of buckets) if (entry.window !== window) buckets.delete(name)
  let entry = buckets.get(bucket)
  if (!entry || entry.window !== window) buckets.set(bucket, (entry = { window, count: 0 }))
  entry.count++
  return entry.count > limit ? Math.max(1, Math.ceil(((window + 1) * 60000 - now) / 1000)) : 0
}

function parseBatch(bytes) {
  let batch
  try { batch = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw sizedError('invalid JSON', 400) }
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) throw sizedError('JSON object required', 400)
  const id = batch.session?.id
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw sizedError('session.id required', 400)
  const formatVersion = batch.sessionFormatVersion
  if (!Number.isSafeInteger(formatVersion) || formatVersion < 0 || formatVersion > 999999) throw sizedError('sessionFormatVersion required', 400)
  if (!Array.isArray(batch.events) || !batch.events.length) throw sizedError('events required', 400)
  for (const event of batch.events) {
    if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.seq) || event.seq < 0) throw sizedError('event seq required', 400)
  }
  return { batch, id, formatVersion }
}

// What the index keeps of a batch: models used, token totals and the latest title. Event shapes
// follow dsh_session_log; anything unrecognised is simply not summarised.
function summarize(events) {
  const models = new Set()
  const tokens = { input: 0, output: 0, total: 0 }
  let title = null
  for (const { type, data } of events) {
    if (!data || typeof data !== 'object') continue
    const model = type === 'assistant/message' ? data.message?.source?.model
      : ['request/context', 'model/selection', 'compaction/summary'].includes(type) ? data.model : undefined
    if (clip(model)) models.add(clip(model))
    if ((type === 'assistant/message' || type === 'compaction/summary') && data.usage && typeof data.usage === 'object') {
      const input = count(data.usage.inputTokens), output = count(data.usage.outputTokens)
      tokens.input += input
      tokens.output += output
      tokens.total += count(data.usage.totalTokens) || input + output
    }
    if (type === 'session/title' && clip(data.title)) title = clip(data.title, 300)
  }
  return { models, tokens, title }
}

function objectPrefix(id, formatVersion, createdAt, now) {
  const date = new Date(Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : now)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `session-logs/${date.getUTCFullYear()}/${month}/${id}/${formatVersion}/`
}

// One upload per session at a time in this process, so the duplicate check, the object write and
// the index update of two overlapping retries cannot interleave.
const sessionQueues = new Map()
async function serialized(name, task) {
  const previous = sessionQueues.get(name) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  sessionQueues.set(name, current)
  try { return await current } finally { if (sessionQueues.get(name) === current) sessionQueues.delete(name) }
}

async function store(env, { batch, id, formatVersion }, { keyFingerprint, sealedKey }, now) {
  const db = env.MARKET_SESSION_LOG_DB
  const unique = new Map()
  for (const event of batch.events) if (!unique.has(event.seq)) unique.set(event.seq, event)
  const seqs = [...unique.keys()].sort((first, second) => first - second)
  const existing = await db.prepare('SELECT object_prefix,models FROM session_log_sessions WHERE session_id=? AND format_version=?')
    .bind(id, formatVersion).first()
  const { results } = await db.prepare('SELECT seq FROM session_log_events WHERE session_id=? AND format_version=? AND seq BETWEEN ? AND ?')
    .bind(id, formatVersion, seqs[0], seqs.at(-1)).all()
  const known = new Set(results.map(row => row.seq))
  const fresh = seqs.filter(seq => !known.has(seq)).map(seq => unique.get(seq))
  // A batch that only repeats stored events is accepted without writing anything.
  if (!fresh.length) return { stored: 0, duplicates: batch.events.length }

  const session = batch.session
  const prefix = existing?.object_prefix ?? objectPrefix(id, formatVersion, session.createdAt, now)
  const key = `${prefix}${fresh[0].seq - 1}-${fresh.at(-1).seq}.json.gz`
  const object = await gzip(new TextEncoder().encode(JSON.stringify({
    version: batch.version, sessionFormatVersion: formatVersion, session,
    afterSeq: batch.afterSeq, throughSeq: batch.throughSeq, receivedAt: now,
    client: batch.client, account: batch.account, events: fresh,
  })))
  await env.MARKET_SESSION_LOG_STORE.put(key, object)

  const summary = summarize(fresh)
  let models = []
  try { models = JSON.parse(existing?.models ?? '[]') } catch {}
  models = [...new Set([...models, ...summary.models])].slice(0, 50)
  const accountId = typeof batch.account?.id === 'number' ? String(batch.account.id) : clip(batch.account?.id, 128)
  await db.batch([
    db.prepare(`INSERT INTO session_log_sessions(session_id,format_version,object_prefix,key_fingerprint,account_id,client_product,
        client_version,client_platform,cwd,parent_session,origin,title,created_at,first_received_at,last_received_at,stored_bytes,models,
        input_tokens,output_tokens,total_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,format_version) DO UPDATE SET
        key_fingerprint=COALESCE(excluded.key_fingerprint,key_fingerprint), account_id=COALESCE(excluded.account_id,account_id),
        client_product=COALESCE(excluded.client_product,client_product), client_version=COALESCE(excluded.client_version,client_version),
        client_platform=COALESCE(excluded.client_platform,client_platform), cwd=COALESCE(excluded.cwd,cwd),
        parent_session=COALESCE(excluded.parent_session,parent_session), origin=COALESCE(excluded.origin,origin),
        title=COALESCE(excluded.title,title), created_at=COALESCE(created_at,excluded.created_at),
        last_received_at=excluded.last_received_at, stored_bytes=stored_bytes+excluded.stored_bytes, models=excluded.models,
        input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
        total_tokens=total_tokens+excluded.total_tokens`)
      .bind(id, formatVersion, prefix, keyFingerprint, accountId, clip(batch.client?.product, 80), clip(batch.client?.version, 80),
        clip(batch.client?.platform, 40), clip(session.cwd, 1000), clip(session.parentSession, 128), clip(session.origin, 200),
        summary.title, Number.isSafeInteger(session.createdAt) ? session.createdAt : null, now, now, object.byteLength,
        JSON.stringify(models), summary.tokens.input, summary.tokens.output, summary.tokens.total),
    // Every Key the session was uploaded with. The newest seal wins, so a rotated encryption
    // secret is healed by the next upload.
    ...(keyFingerprint ? [db.prepare(`INSERT INTO session_log_keys(session_id,format_version,key_fingerprint,encrypted_key,first_used_at,last_used_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,format_version,key_fingerprint) DO UPDATE SET
        encrypted_key=COALESCE(excluded.encrypted_key,encrypted_key), last_used_at=excluded.last_used_at`)
      .bind(id, formatVersion, keyFingerprint, sealedKey, now, now)] : []),
    ...fresh.map(event => db.prepare('INSERT OR IGNORE INTO session_log_events(session_id,format_version,seq,object_key,time,type,turn) VALUES(?,?,?,?,?,?,?)')
      .bind(id, formatVersion, event.seq, key, Number.isSafeInteger(event.time) ? event.time : null,
        typeof event.type === 'string' ? event.type.slice(0, 128) : '', Number.isSafeInteger(event.data?.turn) ? event.data.turn : null)),
    // Gaps are kept, not refused: max_seq + 1 - event_count is how many events never arrived.
    db.prepare(`UPDATE session_log_sessions SET
        event_count=(SELECT COUNT(*) FROM session_log_events WHERE session_id=?1 AND format_version=?2),
        max_seq=(SELECT COALESCE(MAX(seq),-1) FROM session_log_events WHERE session_id=?1 AND format_version=?2)
      WHERE session_id=?1 AND format_version=?2`).bind(id, formatVersion),
  ])
  return { stored: fresh.length, duplicates: batch.events.length - fresh.length }
}

/** POST /v1/session-logs. Never 401: an upload without a Key is stored as anonymous. */
export async function sessionLogUpload(request, env) {
  if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405, { allow: 'POST' })
  if (!configured(env)) return reply({ error: '会话日志未配置' }, 503)
  try {
    const now = Date.now()
    const key = bearer(request)
    const keyFingerprint = key ? await fingerprint(key, env.MARKET_HMAC_SECRET) : null
    const wait = rateWait(env, keyFingerprint ? 'key:' + keyFingerprint : 'ip:' + (request.headers.get('cf-connecting-ip') || 'unknown'), now)
    if (wait) return reply({ error: 'too many requests' }, 429, { 'retry-after': String(wait) })
    const declared = Number(request.headers.get('content-length'))
    if (declared > SESSION_LOG_BODY_LIMIT) return reply({ error: 'too large' }, 413)
    if (!request.body) throw sizedError('body required', 400)
    let bytes = await readLimited(request.body, SESSION_LOG_BODY_LIMIT)
    const encoding = (request.headers.get('content-encoding') ?? '').trim().toLowerCase()
    if (encoding === 'gzip') bytes = await gunzip(bytes, SESSION_LOG_JSON_LIMIT)
    else if (encoding && encoding !== 'identity') return reply({ error: 'unsupported content encoding' }, 415)
    else if (bytes.byteLength > SESSION_LOG_JSON_LIMIT) throw sizedError('too large', 413)
    const parsed = parseBatch(bytes)
    // No encryption secret, no Key: it is never stored in the clear.
    const sealedKey = key && env.MARKET_KEY_ENCRYPTION_SECRET ? await sealKey(key, SEALED_FOR, keyFingerprint, env) : null
    const result = await serialized(`${parsed.id}\0${parsed.formatVersion}`, () => store(env, parsed, { keyFingerprint, sealedKey }, now))
    return reply({ ok: true, ...result })
  } catch (error) {
    if ([400, 413].includes(error?.status)) return reply({ error: error.message }, error.status)
    // Only the error class is logged: a message could quote the body, and the body is not redacted.
    console.error('session-log upload failed:', error?.code ?? error?.name ?? 'Error')
    return reply({ error: '会话日志暂时不可用' }, 503)
  }
}

// ── Console ──────────────────────────────────────────────────────────────────

const ready = env => { if (!configured(env)) throw invalid('会话日志存储未配置', 503) }
const target = (id, formatVersion) => `${id}:${formatVersion}`
/** Whether Keys are kept (sealed) and can be shown; false means only fingerprints are known. */
const keyDisplayReady = env => Boolean(env.MARKET_KEY_ENCRYPTION_SECRET)
function sessionView(row, keys) {
  let models = []
  try { models = JSON.parse(row.models) } catch {}
  return {
    id: row.session_id, formatVersion: row.format_version,
    key: keys.text.get(row.key_fingerprint) ?? null, keyFingerprint: row.key_fingerprint,
    keyLabel: keys.labels.get(row.key_fingerprint) ?? null, accountId: row.account_id,
    client: { product: row.client_product, version: row.client_version, platform: row.client_platform },
    cwd: row.cwd, parentSession: row.parent_session, origin: row.origin, title: row.title,
    createdAt: row.created_at, firstReceivedAt: row.first_received_at, lastReceivedAt: row.last_received_at,
    eventCount: row.event_count, maxSeq: row.max_seq, missingEvents: Math.max(0, row.max_seq + 1 - row.event_count),
    storedBytes: row.stored_bytes, models,
    tokens: { input: row.input_tokens, output: row.output_tokens, total: row.total_tokens },
  }
}
const marks = values => values.map(() => '?').join(',')
// The Keys behind some fingerprints, opened from the newest seal of each (every seal of one
// fingerprint holds the same Key). Without the encryption secret nothing can be opened.
async function openKeys(env, fingerprints) {
  const text = new Map()
  if (!env.MARKET_KEY_ENCRYPTION_SECRET) return text
  const { results } = await env.MARKET_SESSION_LOG_DB.prepare(`SELECT key_fingerprint,encrypted_key,MAX(last_used_at) FROM session_log_keys
    WHERE encrypted_key IS NOT NULL${fingerprints ? ` AND key_fingerprint IN (${marks(fingerprints)})` : ''} GROUP BY key_fingerprint`)
    .bind(...(fingerprints ?? [])).all()
  for (const row of results) {
    try { text.set(row.key_fingerprint, await openKey(row.encrypted_key, SEALED_FOR, row.key_fingerprint, env)) } catch {}
  }
  return text
}
// Each Key as text where it was sealed, and its note where the Key directory knows it.
async function describeKeys(env, fingerprints) {
  const unique = [...new Set(fingerprints.filter(Boolean))]
  if (!unique.length) return { text: new Map(), labels: new Map() }
  const labels = new Map()
  if (env.MARKET_DB) {
    const { results } = await env.MARKET_DB.prepare(`SELECT fingerprint,label FROM market_keys WHERE fingerprint IN (${marks(unique)})`).bind(...unique).all()
    for (const row of results) labels.set(row.fingerprint, row.label || null)
  }
  return { text: await openKeys(env, unique), labels }
}
// The fingerprints a Key filter names: the whole Key, the beginning of a Key that was sealed, or
// (as before the Keys were kept) the beginning of a fingerprint.
async function keysMatching(env, value) {
  const found = new Set([await fingerprint(value, env.MARKET_HMAC_SECRET)])
  for (const [print, key] of await openKeys(env)) if (key.startsWith(value)) found.add(print)
  if (FINGERPRINT_PREFIX.test(value)) {
    const { results } = await env.MARKET_SESSION_LOG_DB.prepare("SELECT DISTINCT key_fingerprint FROM session_log_keys WHERE key_fingerprint LIKE ? || '%'")
      .bind(value).all()
    for (const row of results) found.add(row.key_fingerprint)
  }
  return [...found]
}
function timestamp(value, name) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw invalid(`${name} 应为毫秒时间戳`)
  return number
}
const sessionTime = 'COALESCE(created_at,first_received_at)'

export async function listSessionLogs(env, url) {
  ready(env)
  const where = [], values = []
  const filter = (name, sql, check = value => value.length <= 200) => {
    const value = url.searchParams.get(name)?.trim()
    if (!value) return
    if (!check(value)) throw invalid(`筛选条件 ${name} 无效`)
    where.push(sql)
    values.push(value)
  }
  filter('account', 'account_id=?')
  // Any Key the session used, not only its latest one.
  const key = url.searchParams.get('key')?.trim()
  if (key) {
    if (key.length > 300) throw invalid('筛选条件 key 无效')
    const prints = await keysMatching(env, key)
    where.push(`EXISTS (SELECT 1 FROM session_log_keys k WHERE k.session_id=session_log_sessions.session_id
      AND k.format_version=session_log_sessions.format_version AND k.key_fingerprint IN (${marks(prints)}))`)
    values.push(...prints)
  }
  filter('clientVersion', 'client_version=?')
  filter('model', 'EXISTS (SELECT 1 FROM json_each(models) WHERE value=?)')
  filter('session', 'session_id=?', value => SESSION_ID.test(value))
  const from = timestamp(url.searchParams.get('from'), 'from'), to = timestamp(url.searchParams.get('to'), 'to')
  if (from !== null) { where.push(`${sessionTime}>=?`); values.push(from) }
  if (to !== null) { where.push(`${sessionTime}<?`); values.push(to) }
  if (url.searchParams.get('anonymous') === 'true') where.push('key_fingerprint IS NULL')
  const page = Number(url.searchParams.get('page') || '1')
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw invalid('页码无效')
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
  const db = env.MARKET_SESSION_LOG_DB
  const total = (await db.prepare('SELECT COUNT(*) AS total FROM session_log_sessions' + clause).bind(...values).first()).total
  const { results } = await db.prepare(`SELECT * FROM session_log_sessions${clause} ORDER BY last_received_at DESC,session_id LIMIT ? OFFSET ?`)
    .bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE).all()
  const keys = await describeKeys(env, results.map(row => row.key_fingerprint))
  return { items: results.map(row => sessionView(row, keys)), total, page, pageSize: PAGE_SIZE, keyDisplayReady: keyDisplayReady(env) }
}

function address(id, version) {
  const formatVersion = /^[0-9]{1,6}$/u.test(version ?? '') ? Number(version) : -1
  if (!SESSION_ID.test(id ?? '') || formatVersion < 0) throw invalid('会话无效')
  return { id, formatVersion }
}
async function sessionRow(env, id, formatVersion) {
  const row = await env.MARKET_SESSION_LOG_DB.prepare('SELECT * FROM session_log_sessions WHERE session_id=? AND format_version=?')
    .bind(id, formatVersion).first()
  if (!row) throw invalid('会话不存在', 404)
  return row
}

// One stored batch, parsed; null when the object is gone or unreadable.
async function readObject(env, key) {
  const bytes = await env.MARKET_SESSION_LOG_STORE.get(key)
  if (!bytes) return null
  try { return JSON.parse(new TextDecoder().decode(await gunzip(bytes, 64 * MiB))) } catch { return null }
}
// The index says which object holds each seq; an overlapping batch never stored a copy twice, so
// taking each seq from its indexed object is the merge. Returns the events in seq order and the
// header (version, session, client, account) of the object that holds the newest seq.
async function readEvents(env, rows, headerKey) {
  const objects = new Map()
  let header = null
  for (const key of new Set([...rows.map(item => item.object_key), ...(headerKey ? [headerKey] : [])])) {
    const object = await readObject(env, key)
    objects.set(key, new Map((Array.isArray(object?.events) ? object.events : []).map(event => [event.seq, event])))
    if (key === headerKey && object) header = { version: object.version, sessionFormatVersion: object.sessionFormatVersion,
      session: object.session, client: object.client, account: object.account }
  }
  return {
    header,
    events: rows.map(item => objects.get(item.object_key).get(item.seq) ?? { seq: item.seq, time: item.time, type: item.type, unavailable: true }),
  }
}
const newestObject = async (env, id, formatVersion) => (await env.MARKET_SESSION_LOG_DB.prepare(
  'SELECT object_key FROM session_log_events WHERE session_id=? AND format_version=? ORDER BY seq DESC LIMIT 1',
).bind(id, formatVersion).first())?.object_key ?? null

/**
 * One page of a session's events, read from the raw objects and merged by seq. The first page
 * (no `after`) also carries the upload header and is the one that is audited: opening a session
 * is one read, however many pages it then takes to load.
 */
export async function sessionLogDetail(env, segments, url, actor) {
  ready(env)
  const { id, formatVersion } = address(...segments)
  const row = await sessionRow(env, id, formatVersion)
  const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : -1
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 200
  if (!Number.isSafeInteger(after) || after < -1) throw invalid('after 无效')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw invalid('limit 应为 1-1000')
  const opening = after === -1
  const { results } = await env.MARKET_SESSION_LOG_DB.prepare(
    'SELECT seq,object_key,time,type FROM session_log_events WHERE session_id=? AND format_version=? AND seq>? ORDER BY seq LIMIT ?',
  ).bind(id, formatVersion, after, limit).all()
  const { header, events } = await readEvents(env, results, opening ? await newestObject(env, id, formatVersion) : null)
  if (opening) await env.MARKET_DB.batch(auditStatements(env, 'session-log.viewed', target(id, formatVersion), {}, actor))
  const used = (await env.MARKET_SESSION_LOG_DB.prepare(
    'SELECT key_fingerprint,first_used_at,last_used_at FROM session_log_keys WHERE session_id=? AND format_version=? ORDER BY first_used_at,key_fingerprint',
  ).bind(id, formatVersion).all()).results
  const keys = await describeKeys(env, [row.key_fingerprint, ...used.map(item => item.key_fingerprint)])
  return {
    session: sessionView(row, keys),
    keys: used.map(item => ({ key: keys.text.get(item.key_fingerprint) ?? null, fingerprint: item.key_fingerprint,
      label: keys.labels.get(item.key_fingerprint) ?? null, firstUsedAt: item.first_used_at, lastUsedAt: item.last_used_at })),
    keyDisplayReady: keyDisplayReady(env),
    ...(opening ? { header } : {}),
    events,
    next: results.length === limit ? results.at(-1).seq : null,
  }
}

/**
 * The whole session as one download: `{ version, sessionFormatVersion, session, client, account,
 * events }` in the upload format, events merged and de-duplicated by seq, or the events alone as
 * JSON Lines. The header is the newest upload's, the same one the detail's first page carries, so
 * the console's raw view and this file are the same text. Every download is audited.
 */
export async function sessionLogRaw(env, segments, url, actor) {
  ready(env)
  const { id, formatVersion } = address(...segments)
  const format = url.searchParams.get('format') ?? 'json'
  if (!['json', 'jsonl'].includes(format)) throw invalid('format 应为 json 或 jsonl')
  await sessionRow(env, id, formatVersion)
  const { results } = await env.MARKET_SESSION_LOG_DB.prepare(
    'SELECT seq,object_key,time,type FROM session_log_events WHERE session_id=? AND format_version=? ORDER BY seq',
  ).bind(id, formatVersion).all()
  const { header, events } = await readEvents(env, results, results.at(-1)?.object_key ?? null)
  await env.MARKET_DB.batch(auditStatements(env, 'session-log.downloaded', target(id, formatVersion), { format }, actor))
  const text = format === 'json'
    ? JSON.stringify({ ...(header ?? { version: null, sessionFormatVersion: formatVersion, session: { id } }), events }, null, 2) + '\n'
    : events.map(event => JSON.stringify(event) + '\n').join('')
  return new Response(text, {
    headers: {
      'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      // The session id is [A-Za-z0-9._-] only, so it is safe in the header as it is.
      'content-disposition': `attachment; filename="${id}.${format}"`,
      'cache-control': 'no-store',
      'vary': 'Authorization, Cookie',
    },
  })
}

// Objects first: a failure then leaves an index row to retry the deletion from, never an orphan.
async function removeSession(env, row) {
  for (const key of await env.MARKET_SESSION_LOG_STORE.list(row.object_prefix)) await env.MARKET_SESSION_LOG_STORE.delete(key)
  await env.MARKET_SESSION_LOG_DB.prepare('DELETE FROM session_log_sessions WHERE session_id=? AND format_version=?')
    .bind(row.session_id, row.format_version).run()
}

export async function deleteSessionLog(env, segments, actor) {
  ready(env)
  const { id, formatVersion } = address(...segments)
  await removeSession(env, await sessionRow(env, id, formatVersion))
  await env.MARKET_DB.batch(auditStatements(env, 'session-log.deleted', target(id, formatVersion), { count: 1 }, actor))
  return { ok: true, count: 1 }
}

async function removeWhere(env, clause, values) {
  const { results } = await env.MARKET_SESSION_LOG_DB.prepare('SELECT session_id,format_version,object_prefix FROM session_log_sessions WHERE ' + clause)
    .bind(...values).all()
  for (const row of results) await removeSession(env, row)
  return results.length
}

/** Deletes every session whose creation time falls in [from, to). */
export async function deleteSessionLogRange(env, data, actor) {
  ready(env)
  const from = timestamp(data?.from, 'from') ?? 0, to = timestamp(data?.to, 'to')
  if (to === null || to <= from) throw invalid('请提供有效的时间范围（to 必须晚于 from）')
  const removed = await removeWhere(env, `${sessionTime}>=? AND ${sessionTime}<?`, [from, to])
  await env.MARKET_DB.batch(auditStatements(env, 'session-log.deleted', 'range', { count: removed }, actor))
  return { ok: true, count: removed }
}

async function retentionDays(env) {
  const row = await env.MARKET_SESSION_LOG_DB.prepare("SELECT value FROM session_log_settings WHERE name='retentionDays'").first()
  const days = row ? Number(row.value) : null
  return Number.isSafeInteger(days) && days > 0 ? days : null
}

export async function sessionLogSettings(env) {
  ready(env)
  return { retentionDays: await retentionDays(env) }
}

/** retentionDays: null keeps everything (the default); N removes sessions idle for more than N days. */
export async function saveSessionLogSettings(env, data, actor) {
  ready(env)
  const days = data?.retentionDays
  if (days !== null && !(Number.isSafeInteger(days) && days >= 1 && days <= 36500)) throw invalid('保留天数应为 1-36500 的整数，或留空表示永久保留')
  await env.MARKET_SESSION_LOG_DB.prepare(days === null
    ? "DELETE FROM session_log_settings WHERE name='retentionDays'"
    : "INSERT INTO session_log_settings(name,value) VALUES('retentionDays',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
    .bind(...(days === null ? [] : [String(days)])).run()
  await env.MARKET_DB.batch(auditStatements(env, 'session-log.settings', 'retention', { retentionDays: days }, actor))
  return { retentionDays: days }
}

/** The retention job: removes sessions last uploaded more than retentionDays ago. Returns how many. */
export async function purgeExpiredSessionLogs(env, now = Date.now()) {
  if (!configured(env)) return 0
  const days = await retentionDays(env)
  if (days === null) return 0
  const removed = await removeWhere(env, 'last_received_at<?', [now - days * DAY])
  if (removed) await env.MARKET_DB.batch(auditStatements(env, 'session-log.purged', 'retention', { count: removed, retentionDays: days },
    { kind: 'root', id: 'retention', organizationId: null }))
  return removed
}
