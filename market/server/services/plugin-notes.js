import { idOK } from '../http/request.js'
import { npmPackument, npmTarball } from '../integrations/npm-registry.js'
import { packageFiles } from '../integrations/package-files.js'
import { createRegistryClient } from '../private-registry/client.mjs'
import { allowed } from './access.js'
import { auditStatements } from './audit.js'
import { selectCatalogSources } from './catalog-source-service.js'
import { invalid, pluginRow, pluginView, stable, versionOK } from './plugins.js'

// What changed in each version of a plugin ("更新说明"), in Chinese and in English (T0113).
//
// Two sources per language. The automatic one is the section for that version in the CHANGELOG.md
// (and optional CHANGELOG.en.md) inside the version's own package; the administrator's text, written
// in the console, wins over it, and clearing it falls back to the automatic text again.
//
// Packages are read lazily and once: a version is read from its package the first time somebody
// asks for it -- the app's GET /v1/plugins/{id}/notes for the versions in its range, the console for
// the version it shows (the latest when it opens) -- and the result is kept in market_plugin_notes.
// A published version never changes, so it is never read again; a failed read is not kept and is
// tried again a few minutes later. Nothing walks a plugin's history up front.

/** Longest note, in characters; an automatic one is cut at a line break and marked with "…". */
export const MAX_NOTE_LENGTH = 4000
/** Request body limit for saving one version's notes: both languages plus the JSON envelope. */
export const NOTES_BODY_LIMIT = MAX_NOTE_LENGTH * 2 * 4 + 1024
/** Most versions one GET /v1/plugins/{id}/notes answers with. */
export const MAX_RANGE = 20
/** Most versions the console lists. */
const MAX_LISTED = 100
const MAX_ARCHIVE = 32 * 1024 * 1024
const MAX_CHANGELOG = 1024 * 1024
const VERSIONS_TTL = 60_000
const RETRY_AFTER = 5 * 60_000
const CHINESE = /[㐀-䶿一-鿿豈-﫿]/u

/* ----------------------------- 版本号 ----------------------------- */

function semver(version) {
  const plain = version.split('+')[0], dash = plain.indexOf('-')
  return { core: (dash < 0 ? plain : plain.slice(0, dash)).split('.').map(Number), pre: dash < 0 ? [] : plain.slice(dash + 1).split('.') }
}
/** Semantic Versioning precedence: negative when a is older than b. Build metadata is ignored. */
export function compareVersions(a, b) {
  const x = semver(a), y = semver(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === q) continue
    const pn = /^[0-9]+$/u.test(p), qn = /^[0-9]+$/u.test(q)
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/* ----------------------------- 从 CHANGELOG 提取 ----------------------------- */

/** The version a `## …` heading names: `[1.2.3] - date`, `1.2.3 (date)`, `v1.2.3`, `[1.2.3](link)`. */
function headingVersion(title) {
  return /^\[?v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?(?:\([^)]*\))?(?:$|[\s:–—-])/u.exec(title.trim())?.[1]
}

/**
 * The Markdown under the `## [x.y.z]` or `## x.y.z` heading of exactly this version, up to the next
 * `#` or `##` heading; null when the file has no such heading. "Unreleased" never names a version.
 */
export function changelogSection(source, version) {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  let start = -1, fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}(?:```|~~~)/u.test(lines[i])) { fence = !fence; continue }
    if (fence) continue
    const heading = /^(#{1,2})\s+(.*)$/u.exec(lines[i])
    if (!heading) continue
    if (start >= 0) return lines.slice(start, i).join('\n')
    if (heading[1] === '##' && headingVersion(heading[2]) === version) start = i + 1
  }
  return start >= 0 ? lines.slice(start).join('\n') : null
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }

/**
 * A changelog section as the safe subset the app renders (paragraphs, "- " lists, **bold**, `code`):
 * HTML tags and comments, images, link targets, code fences and link definitions are dropped,
 * sub-headings become bold lines, control characters go. Null when nothing is left.
 */
export function noteText(markdown) {
  const lines = markdown.replace(/\r\n?/gu, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/<\/?[A-Za-z][^>]*>/gu, '')
    .split('\n')
    .filter(line => !/^\s{0,3}(?:```|~~~)/u.test(line) && !/^\s{0,3}\[[^\]]+\]:\s*\S/u.test(line) && !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line))
    .map(line => line
      .replace(/^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u, (_, title) => `**${title.replaceAll('**', '')}**`)
      .replace(/^(\s*)>\s?/u, '$1')
      .replace(/^(\s*)[*+]\s+/u, '$1- ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1')
      .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gu, (_, name) => ENTITIES[name])
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/gu, '')
      .trimEnd())
  const text = lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
  return text || null
}

/** At most `max` characters, cut at a line break when one is near the end, marked with "…". */
export function clip(text, max = MAX_NOTE_LENGTH) {
  if (text.length <= max) return text
  let room = text.slice(0, max - 2)
  if (/[\ud800-\udbff]$/u.test(room)) room = room.slice(0, -1)
  const cut = room.lastIndexOf('\n')
  return (cut > max / 2 ? room.slice(0, cut) : room).trimEnd() + '\n…'
}

const CHANGELOG_FILE = /^[^/]+\/changelog(\.en)?\.md$/iu
const pickChangelog = path => { const match = CHANGELOG_FILE.exec(path); return match ? (match[1] ? 'en' : 'main') : undefined }

/**
 * One version's notes out of a package's changelog files ({ main: CHANGELOG.md, en: CHANGELOG.en.md }):
 * a section with Chinese characters in it is the Chinese note, any other the English one; the first
 * file to fill a language keeps it.
 */
export function versionNotes(files, version) {
  const notes = { zh: null, en: null }
  for (const key of ['main', 'en']) {
    const source = files.get(key)
    const section = source === undefined ? null : changelogSection(source, version)
    const text = section === null ? null : noteText(section)
    if (!text) continue
    const language = CHINESE.test(text) ? 'zh' : 'en'
    notes[language] ??= clip(text)
  }
  return notes
}

/* ----------------------------- 包与版本 ----------------------------- */

/** Where a plugin's packages come from (the Registry the catalog installs from), or null for a GitHub plugin. */
function packageSource(env, plugin) {
  const item = pluginView(plugin)
  if (!item.npm) return null
  return { registry: selectCatalogSources([item], env, true)[0].registry === 'tokenscowork' ? 'tokenscowork' : 'npm', name: item.package }
}

const isoTime = value => {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
function packumentVersions(document) {
  const time = document.time && typeof document.time === 'object' ? document.time : {}
  return Object.entries(document.versions)
    .filter(([version, manifest]) => versionOK(version) && manifest && typeof manifest === 'object' && manifest.version === version)
    .map(([version, manifest]) => ({ version, publishedAt: isoTime(time[version]), tarball: typeof manifest.dist?.tarball === 'string' ? manifest.dist.tarball : null }))
}

// Process-local and short: the version list (a minute), extractions in flight, and failed reads
// (retried after five minutes). Package contents themselves live in the database.
const caches = new WeakMap()
function cache(env) {
  if (!caches.has(env)) caches.set(env, { versions: new Map(), running: new Map(), failed: new Map() })
  return caches.get(env)
}

/** Every published version of the package, newest first, each with its publish time and archive address. */
async function packageVersions(env, source) {
  const { versions } = cache(env)
  const key = `${source.registry}:${source.name}`
  const hit = versions.get(key)
  if (hit && (hit.pending || hit.expires > Date.now())) return hit.promise
  if (versions.size >= 256) versions.delete(versions.keys().next().value)
  const entry = { pending: true, expires: 0 }
  entry.promise = (async () => {
    if (source.registry !== 'tokenscowork') return packumentVersions(await npmPackument(source.name))
    const result = await createRegistryClient(env).metadata(source.name)
    if (!result.ok) throw invalid('私有 Registry 暂时不可用', 502)
    return packumentVersions(result.data)
  })().then(list => {
    Object.assign(entry, { pending: false, expires: Date.now() + VERSIONS_TTL })
    return list.sort((a, b) => compareVersions(b.version, a.version))
  }, error => { versions.delete(key); throw error })
  versions.set(key, entry)
  return entry.promise
}

/**
 * The versions there are to describe, newest first: the package's own list, or -- for a GitHub
 * plugin, or while the Registry cannot be read (`available: false`) -- the plugin's version and the
 * versions already stored.
 */
async function knownVersions(env, plugin, source, rows) {
  let entries = [], available = !source
  if (source) {
    try { entries = await packageVersions(env, source); available = true } catch { /* answered from what is stored */ }
  }
  if (!source || !available) {
    const seen = new Set()
    for (const version of [plugin.metadata.version, ...rows.keys()]) {
      if (!versionOK(version) || seen.has(version)) continue
      seen.add(version)
      entries.push({ version, publishedAt: rows.get(version)?.published_at ?? null, tarball: null })
    }
    entries.sort((a, b) => compareVersions(b.version, a.version))
  }
  return { entries, available }
}

async function noteRows(env, pluginId) {
  const { results } = await env.MARKET_DB.prepare('SELECT * FROM market_plugin_notes WHERE plugin_id=?').bind(pluginId).all()
  return new Map(results.map(row => [row.version, row]))
}
/** Whether a stored row holds the automatic notes of the package the plugin points at now. */
const extracted = (row, source) => Boolean(source && row?.extracted_at && row.package === source.name)

async function archive(env, source, url) {
  if (source.registry !== 'tokenscowork') return npmTarball(url, MAX_ARCHIVE)
  const result = await createRegistryClient(env).tarballBytes(url, MAX_ARCHIVE)
  if (!result.ok) throw invalid('私有 Registry 安装包读取失败', 502)
  return result.bytes
}

/** Reads one version's changelog out of its package and stores it; false when the package could not be read. */
async function extract(env, pluginId, source, entry) {
  const { running, failed } = cache(env)
  const key = JSON.stringify([pluginId, source.registry, source.name, entry.version])
  if ((failed.get(key) ?? 0) > Date.now()) return false
  if (running.has(key)) return running.get(key)
  const promise = (async () => {
    try {
      const files = await packageFiles(await archive(env, source, entry.tarball), pickChangelog, { maxFile: MAX_CHANGELOG, maxFiles: 2 })
      const notes = versionNotes(files, entry.version)
      await env.MARKET_DB.prepare(`INSERT INTO market_plugin_notes(plugin_id,version,published_at,package,auto_zh,auto_en,extracted_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(plugin_id,version) DO UPDATE SET published_at=excluded.published_at,package=excluded.package,auto_zh=excluded.auto_zh,
        auto_en=excluded.auto_en,extracted_at=excluded.extracted_at`)
        .bind(pluginId, entry.version, entry.publishedAt, source.name, notes.zh, notes.en, Date.now()).run()
      failed.delete(key)
      return true
    } catch {
      if (failed.size >= 512) failed.delete(failed.keys().next().value)
      failed.set(key, Date.now() + RETRY_AFTER)
      return false
    } finally { running.delete(key) }
  })()
  running.set(key, promise)
  return promise
}

/** Makes sure these versions have been read from their packages (three at a time); the rows as they are then. */
async function withExtracted(env, plugin, source, entries, rows) {
  const missing = source ? entries.filter(entry => entry.tarball && !extracted(rows.get(entry.version), source)) : []
  if (!missing.length) return rows
  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, missing.length) }, async () => {
    while (next < missing.length) await extract(env, plugin.id, source, missing[next++])
  }))
  return noteRows(env, plugin.id)
}

/* ----------------------------- 读者：GET /v1/plugins/{id}/notes ----------------------------- */

const effective = (row, source, language) => row?.[`admin_${language}`] ?? (extracted(row, source) ? row[`auto_${language}`] : null) ?? null

/**
 * The notes of the versions after `from` up to and including `to`, newest first, at most 20; without
 * `from`, the notes of `to` alone. Pre-releases are left out of a range (`to` itself excepted). Who
 * may read them is decided exactly as for the catalog (services/access.js): a plugin the caller may
 * not see answers like one that does not exist.
 */
export async function readerPluginNotes(request, env, pluginId, url) {
  const to = url.searchParams.get('to'), from = url.searchParams.get('from')
  if (!versionOK(to)) throw invalid('请用 to 指定目标版本，例如 to=1.2.0')
  if (from !== null && !versionOK(from)) throw invalid('from 须为版本号，例如 from=1.0.0')
  if (!idOK(pluginId) || !await allowed(request, env, pluginId)) throw invalid('not found', 404)
  const plugin = await pluginRow(env, pluginId)
  if (!plugin) throw invalid('not found', 404)
  const source = packageSource(env, plugin)
  let rows = await noteRows(env, pluginId)
  const { entries } = await knownVersions(env, plugin, source, rows)
  const chosen = from === null
    ? entries.filter(entry => entry.version === to)
    : entries.filter(entry => compareVersions(entry.version, from) > 0 && compareVersions(entry.version, to) <= 0
      && (stable(entry.version) || entry.version === to)).slice(0, MAX_RANGE)
  rows = await withExtracted(env, plugin, source, chosen, rows)
  return { items: chosen.map(entry => {
    const row = rows.get(entry.version)
    return { version: entry.version, publishedAt: entry.publishedAt ?? row?.published_at ?? null, zh: effective(row, source, 'zh'), en: effective(row, source, 'en') }
  }) }
}

/* ----------------------------- 平台管理员 ----------------------------- */

const adminItem = (entry, row, source) => ({
  version: entry.version,
  publishedAt: entry.publishedAt ?? row?.published_at ?? null,
  auto: { zh: extracted(row, source) ? row.auto_zh : null, en: extracted(row, source) ? row.auto_en : null },
  admin: { zh: row?.admin_zh ?? null, en: row?.admin_en ?? null },
  extractedAt: extracted(row, source) ? row.extracted_at : null,
  updatedAt: row?.updated_at ?? null,
})

async function context(env, pluginId) {
  const plugin = await pluginRow(env, pluginId)
  if (!plugin) throw invalid('插件不存在', 404)
  const source = packageSource(env, plugin)
  const rows = await noteRows(env, pluginId)
  const { entries, available } = await knownVersions(env, plugin, source, rows)
  // Stable versions, and any other version that already has notes.
  return { plugin, source, rows, available, entries: entries.filter(entry => stable(entry.version) || rows.has(entry.version)) }
}
function versionSegment(segment) {
  let version
  try { version = decodeURIComponent(segment) } catch { version = '' }
  if (!versionOK(version)) throw invalid('版本不存在', 404)
  return version
}
function entryFor(ctx, version) {
  const entry = ctx.entries.find(item => item.version === version)
  if (entry) return entry
  if (!ctx.available) throw invalid('暂时读不到这个插件的版本列表，请稍后重试', 503)
  throw invalid('版本不存在', 404)
}
const header = ctx => ({ pluginId: ctx.plugin.id, source: ctx.source?.registry ?? 'github', package: ctx.plugin.metadata.package ?? '', versionsAvailable: ctx.available })

/** GET /api/v1/plugins/{id}/notes: the versions, newest first (at most 100); the newest is read from its package. */
export async function listPluginNotes(env, pluginId) {
  const ctx = await context(env, pluginId)
  const entries = ctx.entries.slice(0, MAX_LISTED)
  const rows = await withExtracted(env, ctx.plugin, ctx.source, entries.slice(0, 1), ctx.rows)
  return { ...header(ctx), items: entries.map(entry => adminItem(entry, rows.get(entry.version), ctx.source)) }
}

/** GET /api/v1/plugins/{id}/notes/{version}: one version, read from its package first if it has not been. */
export async function getPluginNote(env, pluginId, segment) {
  const ctx = await context(env, pluginId)
  const entry = entryFor(ctx, versionSegment(segment))
  const rows = await withExtracted(env, ctx.plugin, ctx.source, [entry], ctx.rows)
  return adminItem(entry, rows.get(entry.version), ctx.source)
}

function noteField(value, label) {
  if (value === null) return null
  if (typeof value !== 'string') throw invalid(`${label}须为文字或 null`)
  const text = value.replace(/\r\n?/gu, '\n').trim()
  if (text.length > MAX_NOTE_LENGTH) throw invalid(`${label}不能超过 ${MAX_NOTE_LENGTH} 个字符`)
  return text || null
}

/**
 * PUT /api/v1/plugins/{id}/notes/{version} { zh?, en? }: the administrator's text for one version.
 * A language left out keeps what it had; an empty string or null clears it, and readers get the
 * automatic text again. The payload is checked before the version is looked up.
 */
export async function savePluginNote(env, pluginId, segment, data, actor) {
  const has = { zh: data?.zh !== undefined, en: data?.en !== undefined }
  if (!has.zh && !has.en) throw invalid('请提供 zh 或 en')
  const given = { zh: has.zh ? noteField(data.zh, '中文说明') : null, en: has.en ? noteField(data.en, '英文说明') : null }
  const version = versionSegment(segment)
  const ctx = await context(env, pluginId)
  const entry = entryFor(ctx, version)
  const row = ctx.rows.get(version)
  const zh = has.zh ? given.zh : row?.admin_zh ?? null, en = has.en ? given.en : row?.admin_en ?? null
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare(`INSERT INTO market_plugin_notes(plugin_id,version,published_at,admin_zh,admin_en,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(plugin_id,version) DO UPDATE SET admin_zh=excluded.admin_zh,admin_en=excluded.admin_en,updated_at=excluded.updated_at`)
      .bind(pluginId, version, entry.publishedAt, zh, en, Date.now()),
    ...auditStatements(env, 'plugin.notes.saved', `${pluginId}:${version}`, { zh: zh !== null, en: en !== null }, actor),
  ])
  // Answered like GET of the version: with its automatic text beside the administrator's.
  const rows = await withExtracted(env, ctx.plugin, ctx.source, [entry], await noteRows(env, pluginId))
  return adminItem(entry, rows.get(version), ctx.source)
}
