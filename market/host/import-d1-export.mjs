/**
 * One-shot importer for a `wrangler d1 export` dump. Runs inside a throwaway
 * node:alpine container against the unit's data volume, because the dump
 * carries its own CREATE TABLE statements and therefore has to land on an
 * empty database. Admin sessions and login-rate buckets are dropped: they are
 * tied to the old deployment and everybody just logs in again.
 *
 *   docker run --rm -v tokenscowork-market-host-data:/data \
 *     -v "$PWD:/import:ro" node:24-alpine \
 *     node /import/import-d1-export.mjs /import/market-d1-export.sql
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const [dump, target = '/data/market.sqlite'] = process.argv.slice(2)
if (!dump) {
  console.error('usage: node import-d1-export.mjs <dump.sql> [target.sqlite]')
  process.exit(2)
}
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(target + suffix)) unlinkSync(target + suffix)
}
const db = new DatabaseSync(target)
db.exec(readFileSync(dump, 'utf8'))
db.exec('DELETE FROM market_admin_sessions')
db.exec('DELETE FROM market_admin_login_limits')
for (const table of ['market_plugins', 'market_keys', 'market_grants', 'market_organizations']) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
  console.log(`${table}: ${n}`)
}
db.close()
console.log('imported')
