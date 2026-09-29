/**
 * Production stand-ins for the Cloudflare bindings, so the unchanged worker
 * (market/server/_worker.js) can serve behind any reverse proxy. The contracts
 * mirror ops/market-dev.mjs, which pioneered these shapes for local QA; this
 * module persists to disk instead of fabricating fixtures.
 */
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
