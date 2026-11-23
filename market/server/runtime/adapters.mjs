/**
 * Production stand-ins for the Cloudflare bindings, so the unchanged worker
 * (market/server/_worker.js) can serve behind any reverse proxy. The contracts
 * mirror ops/market-dev.mjs, which pioneered these shapes for local QA; this
 * module persists to disk instead of fabricating fixtures.
 */
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { migrate } from '../database/migrate.mjs'

const runStatement = Symbol('run local prepared statement')

/**
 * D1-compatible facade over a SQLite file. Only the methods the worker uses
 * exist: prepare().bind().first()/all()/run() and batch(). Pending migrations
 * are applied on open, so a restored volume comes up schema-current.
 */
export function createD1Database(path, migrationsDir) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  migrate(db, migrationsDir)
  const wrap = (sql, values = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => db.prepare(sql).run(...values),
    [runStatement]: () => db.prepare(sql).run(...values),
  })
  return {
    prepare: wrap,
    close: () => db.close(),
    // The handle underneath. The worker never touches it; the local QA harness uses it to load
    // fixtures in bulk, which is what lets that harness run this very adapter instead of a
    // second copy of it.
    database: db,
    batch: async statements => {
      // Execute synchronously inside one transaction, so concurrent HTTP requests
      // cannot interleave transactions while awaited D1-compatible methods run.
      db.exec('BEGIN')
      try {
        const results = statements.map(statement => statement[runStatement]())
        db.exec('COMMIT')
        return results
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' }
// The security block Pages applied from market/server/_headers to /admin/*. The console's own files
// are revalidated on every load (no-cache + ETag, so an unchanged file costs a 304 and a release is
// picked up at once); the third-party files under vendor/ keep their names across versions, so
// they are cached for a day and then revalidated the same way.
const ADMIN_CACHE = 'no-cache'
const VENDOR_CACHE = 'public, max-age=86400'
const adminHeaders = {
  'cache-control': ADMIN_CACHE,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

/** 缓存文件名：路由传来的键已校验过包名与版本，这里再按白名单复核一次。 */
const CACHE_ENTRY = /^[A-Za-z0-9._@%~-]{1,180}\.tgz$/u
/** Registry 发布的是 sha512；多条 SRI 取第一条认识的。 */
const SRI_TOKEN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u

function subresourceDigest(integrity) {
  for (const token of String(integrity ?? '').trim().split(/\s+/u)) {
    const match = SRI_TOKEN.exec(token)
    if (match) return { algorithm: match[1], expected: match[2] }
  }
  return undefined
}

/**
 * Disk cache for Registry archives, keyed by package and version. A published
 * version is immutable upstream, so a second install of the same version can be
 * answered locally instead of going back to the Registry. Only a complete
 * archive whose bytes match the Registry's integrity digest is ever kept, and
 * the route decides authorization before it looks anything up here: this is
 * storage, never a permission.
 */
export function createTarballCache(dir, { maxBytes = 2 * 1024 ** 3, maxEntryBytes = 64 * 1024 * 1024 } = {}) {
  mkdirSync(dir, { recursive: true })
  const entryPath = key => (CACHE_ENTRY.test(`${key}.tgz`) ? resolve(dir, `${key}.tgz`) : undefined)

  async function entries() {
    const names = await readdir(dir)
    const found = []
    for (const name of names) {
      const info = await stat(resolve(dir, name)).catch(() => undefined)
      if (info?.isFile()) found.push({ name, size: info.size, mtimeMs: info.mtimeMs })
    }
    return found
  }

  /** Keep the directory under its budget, oldest archive first. */
  async function evict(incoming) {
    const found = (await entries()).filter(item => CACHE_ENTRY.test(item.name))
    let total = found.reduce((sum, item) => sum + item.size, incoming)
    for (const item of found.sort((first, second) => first.mtimeMs - second.mtimeMs)) {
      if (total <= maxBytes) return
      await unlink(resolve(dir, item.name)).catch(() => {})
      total -= item.size
    }
  }

  // A process killed mid-download leaves a partial file behind; one server owns
  // this directory, so nothing in flight can be dropped by accident.
  void entries().then(async found => {
    for (const item of found) {
      if (item.name.endsWith('.part')) await unlink(resolve(dir, item.name)).catch(() => {})
    }
  }).catch(() => {})

  return {
    async read(key) {
      const path = entryPath(key)
      if (path === undefined) return undefined
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || !info.isFile()) return undefined
      return { size: info.size, body: Readable.toWeb(createReadStream(path)) }
    },

    /**
     * Pass an archive through unchanged while hashing and writing it aside.
     * The returned stream never waits for the file: a cache write that fails,
     * mismatches or is abandoned only costs the cache entry, not the download.
     */
    capture(key, body, integrity) {
      const path = entryPath(key)
      const digest = subresourceDigest(integrity)
      // Nothing to verify against means nothing worth keeping.
      if (path === undefined || digest === undefined) return body
      // Exclusive create below, so a concurrent download of the same version
      // simply skips the cache instead of writing over a partial file.
      const temporary = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`
      const reader = body.getReader()
      const hash = createHash(digest.algorithm)
      let handle
      let keeping = true
      let size = 0
      const discard = async () => {
        keeping = false
        const current = handle
        handle = undefined
        await current?.close().catch(() => {})
        await unlink(temporary).catch(() => {})
      }
      const promote = async () => {
        if (!keeping || handle === undefined) return await discard()
        try {
          await handle.close()
          handle = undefined
          if (hash.digest('base64') !== digest.expected) return await unlink(temporary).catch(() => {})
          await evict(size)
          await rename(temporary, path)
        } catch { await unlink(temporary).catch(() => {}) }
      }
      return new ReadableStream({
        async start() {
          handle = await open(temporary, 'wx').catch(() => undefined)
          keeping = handle !== undefined
        },
        async pull(controller) {
          let chunk
          try { chunk = await reader.read() }
          catch (cause) { await discard(); throw cause }
          if (chunk.done) {
            // Promote before closing: the download counts as complete only once
            // the verified archive is in place, so the next request finds it.
            await promote()
            controller.close()
            return
          }
          controller.enqueue(chunk.value)
          if (!keeping) return
          size += chunk.value.byteLength
          // An archive past the entry budget still reaches the client; it just
          // is not worth a cache slot.
          if (size > maxEntryBytes) return await discard()
          hash.update(chunk.value)
          try { await handle.write(chunk.value) } catch { await discard() }
        },
        async cancel(reason) {
          await reader.cancel(reason).catch(() => {})
          await discard()
        },
      })
    },
  }
}

/** ASSETS-compatible static file server rooted at the deployed market/server copy. */
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt'])

/** The encoding to answer with, from Accept-Encoding: brotli, else gzip, else none (q=0 refuses one). */
export function chooseEncoding(header) {
  const accepted = new Map()
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';')
    if (!name) continue
    const q = params.map(param => /^\s*q=([0-9.]+)\s*$/u.exec(param)?.[1]).find(Boolean)
    accepted.set(name, q === undefined ? 1 : Number(q))
  }
  const allows = name => (accepted.get(name) ?? (accepted.has('*') ? accepted.get('*') : 0)) > 0
  return allows('br') ? 'br' : allows('gzip') ? 'gzip' : ''
}
/** Whether If-None-Match names this entity (weak comparison, as RFC 9110 asks for GET). */
const matches = (header, etag) => {
  const value = String(header ?? '').trim()
  if (value === '*') return true
  const bare = etag.replace(/^W\//u, '')
  return value.split(',').some(tag => tag.trim().replace(/^W\//u, '') === bare)
}

/**
 * Static files. Under /admin/ (the console, its scripts and the docs center page) each answer
 * carries a validator and, for text, a compressed body: one file is read, hashed and compressed
 * once per change (keyed on its size and modification time), so repeat visits cost a 304 and a
 * first visit a fraction of the bytes. Everything else is served as before.
 */
export function createAssets(root) {
  const cache = new Map()
  async function entry(path) {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('not a file')
    const known = cache.get(path)
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known
    const data = await readFile(path)
    const fresh = { size: info.size, mtimeMs: info.mtimeMs, data,
      etag: `W/"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}"`, encoded: new Map() }
    cache.set(path, fresh)
    return fresh
  }
  const encode = (file, encoding) => {
    if (!file.encoded.has(encoding)) file.encoded.set(encoding, encoding === 'br'
      ? brotliCompressSync(file.data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: file.data.length } })
      : gzipSync(file.data, { level: 9 }))
    return file.encoded.get(encoding)
  }
  return {
    fetch: async input => {
      const request = input instanceof Request ? input : null
      const url = new URL(request ? request.url : input)
      const pathname = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname
      let decoded
      try { decoded = decodeURIComponent(pathname) } catch { return new Response('Invalid path', { status: 400 }) }
      const path = resolve(root, '.' + decoded)
      if (!path.startsWith(root + sep)) return new Response('Not found', { status: 404 })
      let file
      try { file = await entry(path) } catch { return new Response('Not found', { status: 404 }) }
      const type = MIME[extname(path)] ?? 'application/octet-stream'
      if (!decoded.startsWith('/admin/')) return new Response(file.data, { headers: { 'content-type': type } })
      const compressible = COMPRESSIBLE.has(extname(path)) && file.data.length >= 256
      const headers = {
        'content-type': type, ...adminHeaders, etag: file.etag,
        ...(decoded.startsWith('/admin/assets/vendor/') ? { 'cache-control': VENDOR_CACHE } : {}),
        ...(compressible ? { vary: 'Accept-Encoding' } : {}),
      }
      if (matches(request?.headers.get('if-none-match'), file.etag)) return new Response(null, { status: 304, headers })
      const encoding = compressible ? chooseEncoding(request?.headers.get('accept-encoding')) : ''
      if (!encoding) return new Response(file.data, { headers })
      return new Response(encode(file, encoding), { headers: { ...headers, 'content-encoding': encoding } })
    },
  }
}
