import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, MIGRATIONS } from '../database/migrate.mjs'

// Production sits at 006 and has never seen the runner. Build exactly that: the pre-runner
// files replayed by hand, then data shaped like the production snapshot.
function productionAt006() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of readdirSync(MIGRATIONS).filter(file => file < '007')) db.exec(readFileSync(resolve(MIGRATIONS, name), 'utf8'))
  const run = (sql, ...values) => db.prepare(sql).run(...values)
  db.exec('DELETE FROM market_catalog; DELETE FROM market_plugins')
  const plugins = Array.from({ length: 12 }, (_, i) => `p${i}`)
  plugins.forEach((id, i) => {
    run('INSERT INTO market_plugins(id,visibility,metadata,object_key) VALUES(?,?,?,NULL)', id, i < 4 ? 'restricted' : 'public', JSON.stringify({ id, package: `@tokensapi/${id}` }))
    run('INSERT INTO market_catalog(id,state,revision,version_mode,license_reference,reviewed_version,updated_at) VALUES(?,?,?,?,?,?,?)',
      id, i === 11 ? 'deleted' : 'published', i + 1, 'latest', 'MIT', '1.0.0', 1000 + i)
  })
  for (const id of [1, 2, 3]) run('INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,1)', id, `org${id}`)
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) run('INSERT INTO market_org_policies(plugin_id) VALUES(?)', id)
  run('INSERT INTO market_org_grants(plugin_id,organization_id) VALUES(?,?)', 'p0', 2)
  // Three directory Keys, three fingerprints that only ever appear in grants.
  for (const fp of ['k1', 'k2', 'k3']) run('INSERT INTO market_keys(fingerprint,label,enabled,expires_at) VALUES(?,?,1,NULL)', fp, `label-${fp}`)
  const grants = [['p0', 'k1'], ['p1', 'k1'], ['p2', 'k1'], ['p0', 'k2'], ['p3', 'k2'], ['p1', 'k3'],
    ['p0', 'o1'], ['p1', 'o1'], ['p2', 'o2'], ['p3', 'o2'], ['p0', 'o3']]
  for (const [plugin, fp] of grants) run('INSERT INTO market_plugin_key_grants(plugin_id,fingerprint) VALUES(?,?)', plugin, fp)
  run('INSERT INTO market_plugin_key_values(plugin_id,fingerprint,encrypted_value) VALUES(?,?,?)', 'p1', 'k1', 'cipher-p1')
  run('INSERT INTO market_plugin_key_values(plugin_id,fingerprint,encrypted_value) VALUES(?,?,?)', 'p0', 'k1', 'cipher-p0')
  run("INSERT INTO market_access_subjects(kind,id,label,encrypted_value) VALUES('key','o1','subject label','cipher-subject')")
  run("INSERT INTO market_access_subjects(kind,id,label) VALUES('organization','2','annotation')")
  run('INSERT INTO market_admin_audit(action,target,details,created_at) VALUES(?,?,?,?)', 'plugin.published', 'p0', '{}', 5)
  run('INSERT INTO market_admin_sessions(token_hash,expires_at,credential_version) VALUES(?,?,?)', 'h', 9, 'v')
  return db
}

const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'market_%' ORDER BY name").all().map(row => row.name)

test('007 folds the production-shaped schema into eight tables without losing a grant', () => {
  const db = productionAt006()
  migrate(db)
  assert.deepEqual(tables(db), ['market_audit_events', 'market_data_migrations', 'market_grants', 'market_keys',
    'market_login_limits', 'market_org_hidden', 'market_organizations', 'market_plugins', 'market_schema_migrations', 'market_sessions',
    'market_users'])
  const plugins = db.prepare('SELECT id,visibility,state,revision,license_reference,updated_at FROM market_plugins ORDER BY updated_at').all()
  assert.equal(plugins.length, 12)
  assert.equal(plugins.filter(row => row.visibility === 'restricted').length, 4)
  assert.deepEqual({ ...plugins[11] }, { id: 'p11', visibility: 'public', state: 'deleted', revision: 12, license_reference: 'MIT', updated_at: 1011 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_organizations').get().n, 3)
  const grants = db.prepare('SELECT plugin_id,kind,subject FROM market_grants ORDER BY kind,subject,plugin_id').all().map(row => `${row.kind}:${row.subject}:${row.plugin_id}`)
  assert.deepEqual(grants, ['key:k1:p0', 'key:k1:p1', 'key:k1:p2', 'key:k2:p0', 'key:k2:p3', 'key:k3:p1',
    'key:o1:p0', 'key:o1:p1', 'key:o2:p2', 'key:o2:p3', 'key:o3:p0', 'org:2:p0'])
  const keys = Object.fromEntries(db.prepare('SELECT * FROM market_keys').all().map(row => [row.fingerprint, { ...row }]))
  assert.deepEqual(Object.keys(keys).sort(), ['k1', 'k2', 'k3', 'o1', 'o2', 'o3'])
  assert.deepEqual([keys.k2.label, keys.o1.label, keys.o2.label], ['label-k2', 'subject label', ''])
  // A per-plugin ciphertext keeps the plugin it was sealed for; a subject one says so.
  assert.deepEqual([keys.k1.encrypted_value, keys.k1.sealed_for], ['cipher-p0', 'p0'])
  assert.deepEqual([keys.o1.encrypted_value, keys.o1.sealed_for], ['cipher-subject', 'subject'])
  assert.equal(keys.k3.encrypted_value, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_audit_events').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_sessions').get().n, 0)
  assert.throws(() => db.prepare("UPDATE market_plugins SET revision=5 WHERE id='p0'").run(), /revision conflict/u)
  // Purging a plugin takes its grants and switches with it.
  db.prepare("INSERT INTO market_org_hidden(organization_id,plugin_id) VALUES(2,'p0')").run()
  db.prepare("DELETE FROM market_plugins WHERE id='p0'").run()
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_grants WHERE plugin_id='p0'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_org_hidden').get().n, 0)
  // 008 lets a plugin be granted to a user, and nothing else.
  db.prepare("INSERT INTO market_grants(plugin_id,kind,subject) VALUES('p1','user','102')").run()
  assert.throws(() => db.prepare("INSERT INTO market_grants(plugin_id,kind,subject) VALUES('p1','team','1')").run(), /CHECK constraint/u)
})

test('the runner applies each file once, so later boots leave data alone', () => {
  const db = productionAt006()
  migrate(db)
  const before = db.prepare('SELECT * FROM market_plugins ORDER BY id').all()
  migrate(db)
  assert.deepEqual(db.prepare('SELECT * FROM market_plugins ORDER BY id').all(), before)
  assert.deepEqual(tables(db).filter(name => ['market_catalog', 'market_org_policies'].includes(name)), [])
})

test('a fresh database lands on the same schema with the seeded plugins as drafts or published', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  migrate(db)
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM market_plugins WHERE state='published'").get().n >= 4)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_grants').get().n, 0)
})
