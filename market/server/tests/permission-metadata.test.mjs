import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../_worker.js'
import { fingerprint } from '../security/key-fingerprint.js'

// Independent fixtures: no production credentials, npm or organization requests.
async function fixture(t, {version = '0.1.0-beta.1', state = 'draft'} = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const dir = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'))
  t.after(() => db.close())
  const metadata = {id:'fixture-finance', package:'@fixture/finance', displayName:'Finance', summary:'Keep this description', version, repository:'', npm:true, category:'optional'}
  const original = JSON.stringify(metadata)
  db.prepare('INSERT INTO market_plugins(id,visibility,state,metadata,reviewed_version) VALUES(?,?,?,?,?)').run(metadata.id,'public',state,original,version)
  db.prepare('INSERT INTO market_organizations(id,name,enabled) VALUES(7,?,1)').run('Fixture organization')
  const key = await fingerprint('sk-fixture-direct', 'fixture-hmac')
  db.prepare("INSERT INTO market_keys(fingerprint,label) VALUES(?,'fixture')").run(key)
  const wrap = (sql, values=[]) => ({bind:(...args)=>wrap(sql,args), first:async()=>db.prepare(sql).get(...values), all:async()=>({results:db.prepare(sql).all(...values)}), run:async()=>db.prepare(sql).run(...values)})
  const env = {MARKET_ADMIN_TOKEN:'fixture-admin', MARKET_HMAC_SECRET:'fixture-hmac', MARKET_KEY_ENCRYPTION_SECRET:'fixture-vault', MARKET_DB:{prepare:wrap,batch:async statements=>{
    db.exec('BEGIN')
    try {const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result}
    catch(error){db.exec('ROLLBACK');throw error}
  }}}
  const row = () => db.prepare('SELECT * FROM market_plugins WHERE id=?').get(metadata.id)
  const grants = kind => db.prepare('SELECT subject FROM market_grants WHERE plugin_id=? AND kind=?').all(metadata.id, kind).map(g => g.subject)
  const save = (extra={}, auth=true) => worker.fetch(new Request(`https://market.test/api/v1/plugins/${metadata.id}/access`,{method:'PUT',
    headers:{Origin:'https://market.test',...(auth?{Authorization:'Bearer fixture-admin'}:{})},
    body:JSON.stringify({visibility:'restricted',organizations:[7],keys:[],revision:row()?.revision,...extra})}),env)
  return {db,env,key,metadata,original,row,grants,save}
}

test('an access save writes scope and grants without touching metadata, version or publication',async t=>{
  for (const state of ['draft','published']) {
    const f=await fixture(t,{version:state==='draft'?'0.1.0-beta.1':'1.0.0',state})
    const response=await f.save({keys:[f.key]})
    assert.equal(response.status,200,await response.text())
    assert.equal(f.row().metadata,f.original);assert.equal(f.row().state,state)
    assert.equal(f.row().revision,2);assert.equal(f.row().visibility,'restricted')
    assert.deepEqual(f.grants('org'),['7']);assert.deepEqual(f.grants('key'),[f.key])
    // The body carries no metadata; spoofed identity fields are simply not read.
    assert.equal((await f.save({metadata:{id:'another-plugin',version:'9.9.9'},organizations:[]})).status,200)
    assert.equal(f.row().metadata,f.original);assert.deepEqual(f.grants('org'),[])
  }
})

test('validation rejects unknown orgs and Keys, malformed lists and stale revisions atomically',async t=>{
  const f=await fixture(t)
  for(const extra of [{organizations:[999]},{organizations:['7']},{keys:['sk-raw-key']},{keys:['a'.repeat(64)]},{visibility:'hidden'},{visibility:undefined},{organizations:'7'}]) {
    assert.equal((await f.save(extra)).status,400,JSON.stringify(extra))
    assert.equal(f.row().revision,1);assert.equal(f.row().visibility,'public')
  }
  assert.equal((await f.save()).status,200)
  assert.equal((await f.save({revision:1})).status,409)
  assert.equal((await f.save({revision:undefined})).status,409)
  assert.equal(f.row().revision,2)
  const batch=f.env.MARKET_DB.batch
  f.env.MARKET_DB.batch=async statements=>{f.db.prepare('UPDATE market_plugins SET revision=revision+1 WHERE id=?').run(f.metadata.id);return batch(statements)}
  assert.equal((await f.save({organizations:[],keys:[f.key]})).status,409)
  assert.deepEqual(f.grants('key'),[]);assert.deepEqual(f.grants('org'),['7'])
})

test('clearing grants leaves the access scope alone, and a public plugin keeps its grants',async t=>{
  const f=await fixture(t)
  await f.save()
  // Dropping the last grant leaves a restricted plugin nobody can install; it does not quietly
  // open the plugin to everyone.
  assert.equal((await f.save({organizations:[]})).status,200)
  assert.equal(f.row().visibility,'restricted');assert.equal(f.row().state,'draft')
  // Opening it up is its own decision. The grants stay, so restricting it again restores them.
  assert.equal((await f.save({visibility:'public'})).status,200)
  assert.equal(f.row().visibility,'public');assert.equal(f.row().state,'draft')
  assert.deepEqual(f.grants('org'),['7'])
})

test('access audit failures roll back the entire update',async t=>{
  const f=await fixture(t)
  f.db.exec("CREATE TRIGGER fail_permission_audit BEFORE INSERT ON market_audit_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  assert.equal((await f.save({keys:[f.key]})).status,503)
  assert.equal(f.row().revision,1);assert.equal(f.row().visibility,'public')
  assert.deepEqual(f.grants('org'),[]);assert.deepEqual(f.grants('key'),[])
})

test('access writes do not bypass login or trash protection',async t=>{
  const f=await fixture(t)
  assert.equal((await f.save({},false)).status,401)
  f.db.prepare("UPDATE market_plugins SET state='deleted',revision=revision+1 WHERE id=?").run(f.metadata.id)
  assert.equal((await f.save()).status,409)
  assert.equal(f.row().metadata,f.original)
})
