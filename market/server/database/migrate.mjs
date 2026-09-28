import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

export const MIGRATIONS = resolve(import.meta.dirname, 'migrations')

/**
 * Applies every migration file the database has not recorded yet, each in its own transaction,
 * in filename order. A database created before this runner existed has no record at all, so its
 * first boot replays 001-006 once — they were written to be replayed — and records them.
 */
export function migrate(db, dir = MIGRATIONS) {
  db.exec('CREATE TABLE IF NOT EXISTS market_schema_migrations(name TEXT PRIMARY KEY)')
  const applied = new Set(db.prepare('SELECT name FROM market_schema_migrations').all().map(row => row.name))
  for (const name of readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue
    db.exec('BEGIN')
    try {
      db.exec(readFileSync(resolve(dir, name), 'utf8'))
      db.prepare('INSERT INTO market_schema_migrations(name) VALUES(?)').run(name)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${name} failed: ${error.message}`)
    }
  }
}
