import { reply } from '../http/response.js'
import { bearer } from '../http/request.js'
import { resolveIdentity, organizationProviderReady, validOrganizationId } from './organizations.js'
import { invalid } from './plugins.js'
import { auditStatements } from './audit.js'

/**
 * Staged rollout of desktop app versions (agent-hub/docs/app-rollout-plan.md, sections 4 and 6).
 * The update plugin asks GET /v1/app/update which version it is offered and finds that version's
 * installer on GitHub Releases itself; this service only answers "which version", and records each
 * installation's current version so the console can count installs.
 */
const DAY = 24 * 60 * 60 * 1000
/** Installs counted on the console: those that checked for updates within this many days. */
export const ACTIVE_DAYS = 7
/** An installation not seen for this many days is forgotten. */
export const INSTALLATION_RETENTION_DAYS = 90
/** How long the update check waits for TokensAPI to name the Key's organization before going on without one. */
const IDENTITY_WAIT_MS = 3000
const STATUSES = ['draft', 'rolling', 'paused', 'full']
const MAX_ORGANIZATIONS = 500
export const APP_RELEASES_URL = 'https://tokensapi.github.io/TokensCowork/releases.json'

// A rollout is for a stable version only; a client may run a pre-release (0.8.0-rc.1 < 0.8.0).
const RELEASE = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/u
const CLIENT_VERSION = /^v?(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/u
const INSTALLATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const PLATFORM = /^[a-z0-9_]{1,16}$/u

function parse(version) {
  const match = CLIENT_VERSION.exec(version)
  return match && { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
}
/** Negative, zero or positive as a is lower, equal or higher. A pre-release is below its release; pre-releases of one release compare equal. */
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  return (x.pre === null ? 1 : 0) - (y.pre === null ? 1 : 0)
}
const newestFirst = (a, b) => compareVersions(b.version, a.version)

/** The installation's fixed 0-99 bucket for one version: the version is in the hash, so each version reaches a different first group. */
export async function rolloutBucket(installationId, version) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${installationId}:${version}`))
  return new DataView(digest).getUint32(0) % 100
}

// Who the Key belongs to, by the same Key -> account -> organization lookup the plugin permissions
// use (cached a minute per Key). No Key, no provider, an upstream failure or a slow answer all mean
// "no organization": the update check never fails or stalls on TokensAPI.
const NOBODY = Object.freeze({ organizationId: null, accountId: null })
async function caller(request, env) {
  const key = bearer(request)
  if (!key || !organizationProviderReady(env)) return NOBODY
  let timer
  try {
    const identity = await Promise.race([resolveIdentity(key, env), new Promise(done => { timer = setTimeout(() => done(null), IDENTITY_WAIT_MS) })])
    return { organizationId: identity?.organization?.id ?? null, accountId: identity?.user?.id ?? null }
  } catch { return NOBODY } finally { clearTimeout(timer) }
}

/**
 * The version offered to one caller: the highest rolling or full version above `current` that the
 * rules give it. Per version, in order: an organization on its hold list is never offered it (not
 * even on a manual check); one on its early list is; anyone else is when the installation's bucket
 * is below the percentage, or always on a manual check. Drafts and paused versions reach nobody.
 */
export async function offeredVersion(env, { current, installationId, organizationId, manual }) {
  const { results } = await env.MARKET_DB.prepare("SELECT version,status,percent FROM app_release_rollouts WHERE status IN ('rolling','full')").all()
  const candidates = results.filter(row => RELEASE.test(row.version) && compareVersions(row.version, current) > 0).sort(newestFirst)
  if (!candidates.length) return null
  const lists = new Map()
  if (organizationId) {
    const { results: rows } = await env.MARKET_DB.prepare('SELECT version,kind FROM app_release_rollout_orgs WHERE organization_id=?').bind(organizationId).all()
    for (const row of rows) lists.set(row.version, row.kind)
  }
  for (const row of candidates) {
    const kind = lists.get(row.version)
    if (kind === 'hold') continue
    if (kind === 'early' || manual) return row.version
    const percent = row.status === 'full' ? 100 : row.percent
    if (percent > 0 && await rolloutBucket(installationId, row.version) < percent) return row.version
  }
  return null
}

function query(url, name, pattern, required) {
  const value = url.searchParams.get(name)
  if (value === null || value === '') {
    if (required) throw invalid(`缺少 ${name}`)
    return ''
  }
  if (value.length > 64 || !pattern.test(value)) throw invalid(`${name} 无效`)
  return value
}

/** GET /v1/app/update?version=&platform=&arch=&manual=1, header X-Installation-Id; anonymous, never cached. */
export async function appUpdateRoute(request, env, url) {
  if (request.method !== 'GET') return reply({ error: 'method not allowed' }, 405)
  if (!env.MARKET_DB) return reply({ error: '市场数据库未配置' }, 503)
  try {
    const installation = request.headers.get('x-installation-id') ?? ''
    if (!INSTALLATION.test(installation)) throw invalid('缺少或无效的 X-Installation-Id（应为 UUID）')
    const installationId = installation.toLowerCase()
    const current = query(url, 'version', CLIENT_VERSION, true).replace(/^v/u, '')
    const platform = query(url, 'platform', PLATFORM, false), arch = query(url, 'arch', PLATFORM, false)
    const manual = url.searchParams.get('manual') === '1'
    const who = await caller(request, env)
    const version = await offeredVersion(env, { current, installationId, organizationId: who.organizationId, manual })
    await recordInstallation(env, { installationId, current, platform, arch, accountId: who.accountId, offered: version })
    return reply({ version })
  } catch (error) {
    if (error?.status === 400) return reply({ error: error.message }, 400)
    return reply({ error: '更新服务暂时不可用' }, 503)
  }
}

// The installation as this check described it. A failed write never changes the answer.
async function recordInstallation(env, { installationId, current, platform, arch, accountId, offered }, now = Date.now()) {
  try {
    await env.MARKET_DB.prepare(`INSERT INTO app_installations(installation_id,version,platform,arch,account_id,offered_version,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET version=excluded.version,platform=excluded.platform,arch=excluded.arch,
      account_id=COALESCE(excluded.account_id,app_installations.account_id),offered_version=excluded.offered_version,last_seen_at=excluded.last_seen_at`)
      .bind(installationId, current, platform, arch, accountId, offered, now, now).run()
  } catch (error) {
    console.error('recording an app installation failed:', error?.code ?? error?.name)
  }
}

/** The hourly job: forgets installations not seen for 90 days. Resolves how many were removed. */
export async function purgeStaleInstallations(env, now = Date.now()) {
  if (!env.MARKET_DB) return 0
  const result = await env.MARKET_DB.prepare('DELETE FROM app_installations WHERE last_seen_at<?').bind(now - INSTALLATION_RETENTION_DAYS * DAY).run()
  return result?.changes ?? result?.meta?.changes ?? 0
}

// ── The console's /api/v1/app-releases (platform administrator only) ─────────────────────────

/**
 * Every rollout, newest version first, with its lists and counts, and the installs per version.
 * Counts are over installations that checked within ACTIVE_DAYS: `upgraded` = those now running the
 * version; `offered` = those plus those whose latest check was answered with it and that have not
 * installed it yet.
 */
export async function listAppReleases(env, now = Date.now()) {
  const since = now - ACTIVE_DAYS * DAY
  const [{ results: rows }, { results: orgs }, { results: installed }, { results: pending }] = await Promise.all([
    env.MARKET_DB.prepare('SELECT version,status,percent,note,created_at,updated_at FROM app_release_rollouts').all(),
    env.MARKET_DB.prepare('SELECT version,organization_id,kind FROM app_release_rollout_orgs ORDER BY organization_id').all(),
    env.MARKET_DB.prepare('SELECT version,COUNT(*) AS n FROM app_installations WHERE last_seen_at>=? GROUP BY version').bind(since).all(),
    env.MARKET_DB.prepare(`SELECT offered_version AS version,COUNT(*) AS n FROM app_installations
      WHERE last_seen_at>=? AND offered_version IS NOT NULL AND offered_version<>version GROUP BY offered_version`).bind(since).all(),
  ])
  const installs = new Map(installed.map(row => [row.version, row.n]))
  const waiting = new Map(pending.map(row => [row.version, row.n]))
  const list = (version, kind) => orgs.filter(row => row.version === version && row.kind === kind).map(row => row.organization_id)
  const versions = installed.filter(row => parse(row.version)).map(row => ({ version: row.version, count: row.n })).sort(newestFirst)
  return {
    items: rows.map(row => ({
      version: row.version, status: row.status, percent: row.percent, note: row.note,
      early: list(row.version, 'early'), hold: list(row.version, 'hold'),
      offered: (installs.get(row.version) ?? 0) + (waiting.get(row.version) ?? 0), upgraded: installs.get(row.version) ?? 0,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })).sort(newestFirst),
    installations: { days: ACTIVE_DAYS, total: installed.reduce((sum, row) => sum + row.n, 0), versions },
  }
}

const noteOK = value => value === undefined || (typeof value === 'string' && value.length <= 200)
async function rollout(env, version) {
  const row = RELEASE.test(version ?? '') ? await env.MARKET_DB.prepare('SELECT version,status,percent,note FROM app_release_rollouts WHERE version=?').bind(version).first() : null
  if (!row) throw invalid('版本不存在', 404)
  return row
}

/** A new rollout, as a draft nobody is offered yet. */
export async function createAppRelease(env, data, actor) {
  const version = typeof data?.version === 'string' ? data.version.trim().replace(/^v/u, '') : ''
  if (!RELEASE.test(version)) throw invalid('版本号须为稳定版格式 x.y.z')
  if (!noteOK(data?.note)) throw invalid('备注最多 200 字')
  if (await env.MARKET_DB.prepare('SELECT 1 FROM app_release_rollouts WHERE version=?').bind(version).first()) throw invalid('该版本已存在', 409)
  const now = Date.now()
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare("INSERT INTO app_release_rollouts(version,status,percent,note,created_at,updated_at) VALUES(?,'draft',0,?,?,?)")
      .bind(version, (data.note ?? '').trim(), now, now),
    ...auditStatements(env, 'app-release.created', version, {}, actor),
  ])
  return { ok: true, version }
}

function organizationList(value, name) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_ORGANIZATIONS || !value.every(validOrganizationId) || new Set(value).size !== value.length)
    throw invalid(`${name} 必须是不重复的组织号列表，最多 ${MAX_ORGANIZATIONS} 个`)
  return value
}

/**
 * Any of status, percent, note and the two organization lists (each replaced as a whole). Full
 * means 100 %; a version that has been offered cannot go back to draft.
 */
export async function changeAppRelease(env, version, data, actor) {
  const row = await rollout(env, version)
  const fields = ['status', 'percent', 'note', 'early', 'hold'].filter(name => data?.[name] !== undefined)
  if (!fields.length) throw invalid('请提供 status、percent、note、early 或 hold')
  if (data.status !== undefined && !STATUSES.includes(data.status)) throw invalid('status 只能是 draft、rolling、paused 或 full')
  if (data.status === 'draft' && row.status !== 'draft') throw invalid('已开始发布的版本不能改回草稿，可以暂停', 409)
  if (data.percent !== undefined && !(Number.isInteger(data.percent) && data.percent >= 0 && data.percent <= 100)) throw invalid('比例须为 0-100 的整数')
  if (!noteOK(data.note)) throw invalid('备注最多 200 字')
  const early = organizationList(data.early, 'early'), hold = organizationList(data.hold, 'hold')
  const status = data.status ?? row.status
  if (status === 'full' && data.percent !== undefined && data.percent !== 100) throw invalid('全量的比例固定为 100')
  const percent = status === 'full' ? 100 : data.percent ?? row.percent
  const { results: current } = await env.MARKET_DB.prepare('SELECT organization_id,kind FROM app_release_rollout_orgs WHERE version=?').bind(row.version).all()
  const finalEarly = early ?? current.filter(o => o.kind === 'early').map(o => o.organization_id)
  const finalHold = hold ?? current.filter(o => o.kind === 'hold').map(o => o.organization_id)
  if (finalEarly.some(id => finalHold.includes(id))) throw invalid('同一个组织不能同时在先发和暂缓名单里')
  for (const id of [...(early ?? []), ...(hold ?? [])]) {
    if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_organizations WHERE id=?').bind(id).first()) throw invalid(`组织 #${id} 未登记`)
  }
  const replace = (kind, ids) => [
    env.MARKET_DB.prepare('DELETE FROM app_release_rollout_orgs WHERE version=? AND kind=?').bind(row.version, kind),
    ...ids.map(id => env.MARKET_DB.prepare('INSERT INTO app_release_rollout_orgs(version,organization_id,kind) VALUES(?,?,?)').bind(row.version, id, kind)),
  ]
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('UPDATE app_release_rollouts SET status=?,percent=?,note=?,updated_at=? WHERE version=?')
      .bind(status, percent, data.note === undefined ? row.note : data.note.trim(), Date.now(), row.version),
    ...(early ? replace('early', early) : []),
    ...(hold ? replace('hold', hold) : []),
    ...auditStatements(env, 'app-release.updated', row.version, { status, percent, earlyCount: finalEarly.length, holdCount: finalHold.length }, actor),
  ])
  return { ok: true }
}

/** Only a draft can be removed; a version that has been offered is paused instead. */
export async function deleteAppRelease(env, version, actor) {
  const row = await rollout(env, version)
  if (row.status !== 'draft') throw invalid('只有草稿可以删除；已开始发布的版本请暂停', 409)
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM app_release_rollouts WHERE version=?').bind(row.version),
    ...auditStatements(env, 'app-release.deleted', row.version, {}, actor),
  ])
  return { ok: true }
}

/** The versions on GitHub Releases, to pick from when creating a rollout; 503 when unreadable (the console then takes a typed version). */
export async function availableAppReleases() {
  let list
  try {
    const response = await fetch(APP_RELEASES_URL, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    list = await response.json()
    if (!Array.isArray(list)) throw new Error('not a list')
  } catch {
    throw invalid('GitHub 发布列表暂时读不到，请直接填写版本号', 503)
  }
  const items = list
    .filter(entry => entry && !entry.draft && typeof entry.tag_name === 'string' && RELEASE.test(entry.tag_name.replace(/^v/u, '')))
    .map(entry => ({ version: entry.tag_name.replace(/^v/u, ''), prerelease: entry.prerelease === true,
      publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null }))
    .sort(newestFirst)
  return { items: items.filter((item, index) => index === 0 || item.version !== items[index - 1].version).slice(0, 50) }
}
