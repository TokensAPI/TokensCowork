/**
 * Production stand-ins for the Cloudflare bindings, so the unchanged worker
 * (market/server/_worker.js) can serve behind any reverse proxy. The contracts
 * mirror ops/market-dev.mjs, which pioneered these shapes for local QA; this
 * module persists to disk instead of fabricating fixtures.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const runStatement = Symbol('run local prepared statement')

/**
 * D1-compatible facade over a SQLite file. Only the methods the worker uses
 * exist: prepare().bind().first()/all()/run() and batch(). Migrations are the
 * same idempotent files CI replays against D1 on every deploy, so replaying
 * them on every boot is safe and keeps a restored volume schema-current.
 */
export function createD1Database(path, migrationsDir) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort()) {
    db.exec(readFileSync(resolve(migrationsDir, name), 'utf8'))
  }
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

// Same shape the admin routes accept for object_key writes; anything else 404s.
const objectKey = /^[a-zA-Z0-9/_.-]{1,240}$/u

/** R2-compatible read-only store over a directory of uploaded packages. */
export function createPackagesStore(root) {
  return {
    get: async key => {
      if (typeof key !== 'string' || !objectKey.test(key)) return null
      if (key.split('/').some(part => ['', '.', '..'].includes(part))) return null
      const path = resolve(root, key)
      if (!path.startsWith(root + sep)) return null
      try { return { body: await readFile(path) } } catch { return null }
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
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
