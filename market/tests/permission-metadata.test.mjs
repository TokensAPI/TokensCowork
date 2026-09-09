import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../_worker.js'

// Independent fixtures: no production credentials, npm or organization requests.
function fixture(t, {version = '0.1.0-beta.1', state = 'draft'} = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const dir = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'))
  t.after(() => db.close())
  const metadata = {id:'fixture-finance', package:'@fixture/finance', displayName:'Finance', summary:'Keep this description', version, repository:'', npm:true, category:'optional'}
  const original = JSON.stringify(metadata)
  db.prepare('INSERT INTO market_plugins(id,visibility,metadata,object_key) VALUES(?,?,?,?)').run(metadata.id,'public',original,'private/finance.tgz')
  db.prepare('INSERT INTO market_catalog(id,state,version_mode,reviewed_version) VALUES(?,?,?,?)').run(metadata.id,state,'latest',version)
  db.prepare('INSERT INTO market_organizations(id,name,enabled) VALUES(7,?,1)').run('Fixture organization')
  const wrap = (sql, values=[]) => ({bind:(...args)=>wrap(sql,args), first:async()=>db.prepare(sql).get(...values), all:async()=>({results:db.prepare(sql).all(...values)}), run:async()=>db.prepare(sql).run(...values)})
  const env = {MARKET_ADMIN_TOKEN:'fixture-admin', MARKET_HMAC_SECRET:'fixture-hmac', MARKET_KEY_ENCRYPTION_SECRET:'fixture-vault', MARKET_DB:{prepare:wrap,batch:async statements=>{
    db.exec('BEGIN')
    try {const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result}
    catch(error){db.exec('ROLLBACK');throw error}
  }}}
  const row = () => db.prepare('SELECT p.*,c.state,c.revision,c.reviewed_version FROM market_plugins p JOIN market_catalog c ON p.id=c.id WHERE p.id=?').get(metadata.id)
  const call = (path, extra={}, auth=true, origin='https://market.test') => worker.fetch(new Request('https://market.test'+path,{method:'PUT',headers:{Origin:origin,...(auth?{Authorization:'Bearer fixture-admin'}:{})},body:JSON.stringify({id:metadata.id,revision:row().revision,...extra})}),env)
  const save = (extra={}) => call('/api/admin/plugin-access',{organizationIds:[7],apiKeys:[],keepFingerprints:[],...extra})
  return {db,env,metadata,original,row,call,save}
}

test('all permission routes allow missing npm repository and Beta drafts without metadata payloads',async t=>{
  for(const path of ['/api/admin/plugins','/api/admin/plugin-keys','/api/admin/plugin-organizations','/api/admin/plugin-access']) {
    await t.test(path,async t=>{
      const f=fixture(t)
      const response=await f.call(path,{visibility:'restricted',organizationIds:[7],apiKeys:['sk-fixture-key'],keepFingerprints:[]})
      assert.equal(response.status,200,await response.text())
      assert.equal(f.row().metadata,f.original)
      assert.equal(f.row().state,'draft')
      assert.equal(f.row().reviewed_version,'0.1.0-beta.1')
      assert.equal(f.row().revision,2)
      assert.equal(f.row().object_key,'private/finance.tgz')
    })
  }
})

test('published npm without repository saves mixed permissions without changing version or publication',async t=>{
  const f=fixture(t,{version:'1.0.0',state:'published'})
  assert.equal((await f.save({apiKeys:['sk-fixture-direct']})).status,200)
  assert.equal(f.row().state,'published');assert.equal(f.row().metadata,f.original)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM market_org_grants WHERE plugin_id=?').get(f.metadata.id).n,1)
  const grants=f.db.prepare('SELECT fingerprint FROM market_plugin_key_grants WHERE plugin_id=?').all(f.metadata.id)
  assert.equal(grants.length,1)
  const encrypted=f.db.prepare('SELECT encrypted_value FROM market_plugin_key_values WHERE plugin_id=?').get(f.metadata.id).encrypted_value
  assert.ok(!encrypted.includes('sk-fixture-direct'))
  assert.equal((await f.save({keepFingerprints:[grants[0].fingerprint]})).status,200)
  assert.equal(f.row().metadata,f.original)
})

test('stale, malformed and spoofed client metadata cannot alter canonical plugin identity',async t=>{
  const f=fixture(t)
  for(const metadata of [null,{},'ignored',{id:'another-plugin',repository:'http://evil.test',version:'9.9.9',npm:false,summary:'Overwrite?'}]) {
    assert.equal((await f.save({metadata})).status,200)
    assert.equal(f.row().metadata,f.original);assert.equal(f.row().state,'draft')
  }
})

test('permission validation still rejects bad orgs, keys, identifiers and stale revisions atomically',async t=>{
  const f=fixture(t)
  for(const extra of [{organizationIds:[999]},{organizationIds:['7']},{apiKeys:['not-a-key']},{keepFingerprints:['a'.repeat(64)]},{id:['fixture-finance']},{objectKey:123},{objectKey:'https://bad.test'},{objectKey:'private/tool.tgz\n'}]) {
    assert.equal((await f.save(extra)).status,400)
    assert.equal(f.row().revision,1);assert.equal(f.row().metadata,f.original)
    assert.equal(f.row().visibility,'public')
  }
  assert.equal((await f.save()).status,200)
  assert.equal((await f.save({revision:1})).status,409)
  assert.equal(f.row().revision,2)
  const batch=f.env.MARKET_DB.batch
  f.env.MARKET_DB.batch=async statements=>{f.db.prepare('UPDATE market_catalog SET revision=revision+1 WHERE id=?').run(f.metadata.id);return batch(statements)}
  assert.equal((await f.save({organizationIds:[],apiKeys:['sk-concurrent']})).status,409)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM market_plugin_key_grants WHERE plugin_id=?').get(f.metadata.id).n,0)
  assert.equal(f.row().metadata,f.original)
})

test('clearing grants requires public confirmation and does not publish a draft',async t=>{
  const f=fixture(t)
  await f.save()
  assert.equal((await f.save({organizationIds:[]})).status,409)
  assert.equal((await f.save({organizationIds:[],confirmPublic:true})).status,200)
  assert.equal(f.row().visibility,'public');assert.equal(f.row().state,'draft')
  assert.equal(f.row().metadata,f.original)
})

test('omitted private object location is preserved; explicit null can clear it',async t=>{
  const f=fixture(t)
  await f.save()
  assert.equal(f.row().object_key,'private/finance.tgz')
  assert.equal((await f.save({objectKey:null})).status,200)
  assert.equal(f.row().object_key,null)
})

test('permission audit failures roll back the entire permission update',async t=>{
  const f=fixture(t)
  f.db.exec("CREATE TRIGGER fail_permission_audit BEFORE INSERT ON market_admin_audit BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  assert.equal((await f.save({apiKeys:['sk-fixture-direct']})).status,503)
  assert.equal(f.row().revision,1);assert.equal(f.row().metadata,f.original)
  assert.equal(f.row().visibility,'public')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM market_org_grants WHERE plugin_id=?').get(f.metadata.id).n,0)
})

test('permission fixes do not bypass login, origin checks or trash protection',async t=>{
  const f=fixture(t)
  assert.equal((await f.call('/api/admin/plugin-access',{},false)).status,401)
  assert.equal((await f.call('/api/admin/plugin-access',{},true,'https://evil.test')).status,403)
  f.db.prepare("UPDATE market_catalog SET state='deleted',revision=revision+1 WHERE id=?").run(f.metadata.id)
  assert.equal((await f.save()).status,409)
  assert.equal(f.row().metadata,f.original)
})
