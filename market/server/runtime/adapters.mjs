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

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }
// The security block Pages applied from market/server/_headers to /admin/*.
const adminHeaders = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
export function createAssets(root) {
  return {
    fetch: async input => {
      const url = new URL(input instanceof Request ? input.url : input)
      const pathname = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname
      let decoded
      try { decoded = decodeURIComponent(pathname) } catch { return new Response('Invalid path', { status: 400 }) }
      const path = resolve(root, '.' + decoded)
      if (!path.startsWith(root + sep)) return new Response('Not found', { status: 404 })
      try {
        const data = await readFile(path)
        return new Response(data, { headers: {
          'content-type': MIME[extname(path)] ?? 'application/octet-stream',
          ...(decoded.startsWith('/admin/') ? adminHeaders : {}),
        } })
      } catch { return new Response('Not found', { status: 404 }) }
    },
  }
}
