import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../_worker.js'
import { catalogMutation } from '../services/catalog-service.js'
import { npmPackage, npmReference } from '../integrations/npm-registry.js'
import { versionOK } from '../services/catalog-service.js'
import { buildProductComponents } from '../../../scripts/generate-market-catalog.mjs'

const m={id:'new-tool',package:'@fixture/new-tool',displayName:'New tool',summary:'A safe fictional plugin',repository:'https://github.com/fixture/new-tool',version:'1.0.0',npm:true}
const dir=new URL('../database/migrations/',import.meta.url)
const files=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()
const migrations=files.map(f=>readFileSync(new URL(f,dir),'utf8'))
// The one-time catalog seed; later data migrations are guarded by market_data_migrations markers.
const seedIndex=files.findIndex(f=>f.startsWith('004-'))
function fixture(t) {
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON')
 for(const sql of migrations)db.exec(sql)
 db.exec('DELETE FROM market_catalog; DELETE FROM market_plugins');t.after(()=>db.close())
 t.mock.method(globalThis,'fetch',async url=>{
   assert.ok(String(url).startsWith('https://registry.npmjs.org/'))
   const rows=db.prepare('SELECT metadata FROM market_plugins').all().map(row=>JSON.parse(row.metadata))
   const item=rows.find(row=>String(url).includes(row.package))
   return Response.json({latest:item?.version ?? '1.0.0'})
 })
 const wrap=(sql,v=[])=>({bind:(...args)=>wrap(sql,args),first:async()=>db.prepare(sql).get(...v),all:async()=>({results:db.prepare(sql).all(...v)}),run:async()=>db.prepare(sql).run(...v)})
 const components=buildProductComponents(JSON.parse(readFileSync(new URL('../../../product.json',import.meta.url),'utf8')))
 const env={MARKET_ADMIN_TOKEN:'fixture-admin',MARKET_HMAC_SECRET:'fixture-hmac',MARKET_KEY_ENCRYPTION_SECRET:'fixture-vault',MARKET_PACKAGES:{get:async()=>({body:'fixture'})},MARKET_DB:{prepare:wrap,batch:async statements=>{db.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());db.exec('COMMIT');return results}catch(e){db.exec('ROLLBACK');throw e}}},ASSETS:{fetch:async input=>String(input).endsWith('/product-components.json')?Response.json(components):new Response('No static catalog',{status:404})}}
 const call=(path,data,token='fixture-admin',origin='https://market.test')=>worker.fetch(new Request('https://market.test'+path,{method:data===undefined?'GET':'PUT',headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})}),env)
 const entry=()=>db.prepare('SELECT * FROM market_catalog WHERE id=?').get(m.id)
 const change=(operation,extra={})=>call('/api/admin/catalog',{id:m.id,operation,revision:entry()?.revision,...extra})
 const create=()=>change('create',{metadata:m})
 const publish=()=>change('publish',{confirmPublic:true})
 const publicList=async(token='')=>(await (await call('/roster.json',undefined,token)).json()).items
 return {db,env,call,entry,change,create,publish,publicList,components}
}
test('new plugin is a draft; publishing requires explicit public confirmation, not a license checkbox',async t=>{
 const f=fixture(t)
 assert.equal((await f.create()).status,200);assert.equal(f.entry().state,'draft')
 assert.deepEqual(await f.publicList(),[])
 assert.equal((await f.change('publish')).status,409)
 assert.equal((await f.change('publish',{licensePassed:true,licenseReference:'https://example.com/gate'})).status,409)
 assert.equal((await f.publish()).status,200)
 assert.equal((await f.publicList())[0].id,m.id)
 const publicText=JSON.stringify(await f.publicList())
 for(const secret of ['licenseReference','reviewedVersion','revision','actions/runs'])assert.ok(!publicText.includes(secret))
})

test('publication requires no license declaration or report but retains public confirmation',async t=>{
 const f=fixture(t);await f.create()
 assert.equal((await f.change('publish',{})).status,409)
 assert.equal((await f.change('publish',{licensePassed:true})).status,409)
 for(const licenseReference of ['http://example.com/report','https://','not-a-url',123]) {
  assert.equal((await f.change('publish',{licensePassed:true,confirmPublic:true,licenseReference})).status,400)
 }
 assert.equal((await f.change('publish',{confirmPublic:true,licenseReference:''})).status,200)
 assert.equal(f.entry().license_reference,'')
 await f.change('archive')
 assert.equal((await f.change('publish',{confirmPublic:true})).status,200)
 assert.equal(f.entry().license_reference,'')
})
test('draft permissions survive publishing, archive, trash and restore without accidental public exposure',async t=>{
 const f=fixture(t);await f.create()
 const permission={id:m.id,metadata:m,apiKeys:['sk-fixture-direct'],keepFingerprints:[],organizationIds:[],objectKey:'fixture/tool.tgz',revision:f.entry().revision}
 assert.equal((await f.call('/api/admin/plugin-access',permission)).status,200)
 assert.deepEqual(await f.publicList('sk-fixture-direct'),[])
 assert.equal((await f.publish()).status,200)
 assert.deepEqual(await f.publicList(),[]);assert.equal((await f.publicList('sk-fixture-direct')).length,1)
 const hash=f.db.prepare('SELECT fingerprint FROM market_plugin_key_grants').get().fingerprint
 assert.equal((await f.call('/downloads/new-tool',undefined,'sk-fixture-direct')).status,200)
 assert.equal((await f.change('trash')).status,409)
 assert.equal((await f.change('archive')).status,200)
 assert.equal((await f.call('/downloads/new-tool',undefined,'sk-fixture-direct')).status,403)
 assert.equal((await f.change('trash')).status,200)
 assert.equal((await f.create()).status,409)
 assert.equal((await f.call('/api/admin/plugin-access',{...permission,revision:f.entry().revision})).status,409)
 assert.equal((await f.change('restore')).status,200);assert.equal(f.entry().state,'draft')
 assert.deepEqual(await f.publicList('sk-fixture-direct'),[])
 assert.equal(f.db.prepare('SELECT fingerprint FROM market_plugin_key_grants').get().fingerprint,hash)
 assert.equal((await f.publish()).status,200)
 assert.equal((await f.publicList('sk-fixture-direct')).length,1)
})
test('metadata edits are database-owned; changing a distribution source withdraws the release and invalidates its review',async t=>{
 const f=fixture(t);await f.create();await f.publish()
 assert.equal((await f.change('edit',{metadata:{...m,displayName:'Better name'}})).status,200)
 assert.equal(f.entry().state,'published');assert.equal((await f.publicList())[0].displayName,'Better name')
 assert.equal((await f.change('edit',{metadata:{...m,version:'2.0.0'}})).status,200)
 assert.equal(f.entry().state,'draft');assert.equal(f.entry().license_reference,'');assert.deepEqual(await f.publicList(),[])
 assert.equal((await f.publish()).status,200)
 assert.equal((await f.call('/api/admin/plugin-access',{id:m.id,metadata:m,organizationIds:[],apiKeys:[],keepFingerprints:[]})).status,200)
 assert.equal((await f.publicList())[0].version,'2.0.0')
})
test('stale edits and permission writes cannot overwrite another administrators changes',async t=>{
 const f=fixture(t);await f.create();const stale=f.entry().revision
 await f.change('edit',{metadata:{...m,displayName:'First editor'}})
 const before=f.db.prepare('SELECT metadata FROM market_plugins').get().metadata
 assert.equal((await f.change('edit',{metadata:m,revision:stale})).status,409)
 assert.equal((await f.change('edit',{metadata:m,revision:undefined})).status,409)
 assert.equal((await f.call('/api/admin/plugin-access',{id:m.id,revision:stale,metadata:m,apiKeys:['sk-late'],keepFingerprints:[],organizationIds:[]})).status,409)
 assert.equal(f.db.prepare('SELECT metadata FROM market_plugins').get().metadata,before)
 assert.equal(f.db.prepare('SELECT count(*) n FROM market_plugin_key_grants').get().n,0)
 // Simulate a competing revision arriving after the initial read, before the batch.
 const batch=f.env.MARKET_DB.batch
 f.env.MARKET_DB.batch=async statements=>{f.db.prepare('UPDATE market_catalog SET revision=revision+1 WHERE id=?').run(m.id);return batch(statements)}
 assert.equal((await f.change('edit',{metadata:m})).status,409)
 assert.equal(f.db.prepare('SELECT metadata FROM market_plugins').get().metadata,before)
})
test('catalog changes roll back if their audit cannot be recorded',async t=>{
 const f=fixture(t);await f.create()
 f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON market_admin_audit BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;")
 const revision=f.entry().revision
 assert.equal((await f.change('edit',{metadata:{...m,displayName:'Not saved'}})).status,503)
 assert.equal(f.entry().revision,revision)
 assert.equal(JSON.parse(f.db.prepare('SELECT metadata FROM market_plugins').get().metadata).displayName,m.displayName)
})
test('built-in identities, malformed metadata, legacy create bypasses and unauthenticated writes are rejected',async t=>{
 const f=fixture(t)
 assert.equal((await f.call('/api/admin/catalog',{operation:'create',id:m.id,metadata:m},'')).status,401)
 assert.equal((await f.call('/api/admin/catalog',{operation:'create',id:m.id,metadata:m},'fixture-admin','https://evil.test')).status,403)
 const invalids=[{package:'../../evil'},{package:'@fixture/tool\n'},{summary:'bad\u0000text'},{version:'1.0.0\n'},{version:'1.0.0-01'},{repository:'https://evil.test/foo'},{npm:false},{displayName:'x'.repeat(121)}]
 for(const fields of invalids)assert.equal((await f.change('create',{metadata:{...m,...fields}})).status,400)
 assert.equal((await f.change('create',{metadata:{...m,package:f.components.items[0].package}})).status,409)
 assert.equal((await f.call('/api/admin/plugins',{id:m.id,metadata:m,visibility:'public'})).status,409)
 await f.create()
 assert.equal((await f.change('edit',{metadata:{...m,package:f.components.items[0].package}})).status,409)
})
test('migration imports optional records once, preserves ACL and never recreates a removed or edited listing',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 for(const sql of migrations.slice(0,seedIndex))db.exec(sql)
 db.prepare('INSERT INTO market_plugins(id,visibility,metadata) VALUES(?,?,?)').run('tokens-media-gen','restricted',JSON.stringify({...m,id:'tokens-media-gen'}))
 db.prepare('INSERT INTO market_org_policies(plugin_id) VALUES(?)').run('tokens-media-gen')
 db.prepare('INSERT INTO market_plugin_key_grants(plugin_id,fingerprint) VALUES(?,?)').run('tokens-media-gen','fixture-fingerprint')
 for(const sql of migrations.slice(seedIndex))db.exec(sql)
 assert.equal(db.prepare('SELECT count(*) n FROM market_catalog').get().n,4)
 assert.equal(db.prepare("SELECT visibility FROM market_plugins WHERE id='tokens-media-gen'").get().visibility,'restricted')
 db.exec("UPDATE market_catalog SET state='deleted',revision=revision+1 WHERE id='tokens-connect'")
 db.prepare("UPDATE market_plugins SET metadata=? WHERE id='tokens-media-gen'").run(JSON.stringify({...m,displayName:'Admin changed'}))
 for(const sql of migrations.slice(seedIndex))db.exec(sql)
 assert.equal(db.prepare("SELECT state FROM market_catalog WHERE id='tokens-connect'").get().state,'deleted')
 assert.equal(JSON.parse(db.prepare("SELECT metadata FROM market_plugins WHERE id='tokens-media-gen'").get().metadata).displayName,'Admin changed')
 assert.equal(db.prepare('SELECT count(*) n FROM market_plugin_key_grants').get().n,1)
})
test('database failures never return a static fallback even when assets contain an obsolete catalog',async t=>{
 const f=fixture(t);f.env.ASSETS.fetch=async()=>Response.json({items:[m]})
 delete f.env.MARKET_DB
 assert.equal((await f.call('/v1/plugins',undefined,'')).status,503)
 f.env.MARKET_DB={prepare:()=>{throw new Error('offline')}}
 assert.equal((await f.call('/v1/plugins',undefined,'')).status,503)
})
test('npm import uses a fixed registry, validates identity and never executes package scripts',async t=>{
 let calls=0
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.ok(url.startsWith('https://registry.npmjs.org/'));assert.equal(options.redirect,'manual');return Response.json({name:m.package,version:'2.0.0',description:'Imported',repository:{url:m.repository+'.git'},scripts:{postinstall:'do not execute'}})})
 assert.equal((await npmPackage(m.package)).version,'2.0.0')
 await assert.rejects(()=>npmPackage('https://evil.test/key'))
 await assert.rejects(()=>npmPackage(m.package,'../../other'))
 assert.equal(calls,2)
})
test('published npm plugins automatically follow latest without changing stored metadata or publication',async t=>{
 const f=fixture(t);await f.create();await f.publish()
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({latest:'9.0.0'})})
 const revision=f.entry().revision
 let catalog=await (await f.call('/v1/plugins',undefined,'')).json();assert.equal(catalog.items[0].latestVersion,'9.0.0');assert.equal(calls,1)
 assert.equal((await f.publicList())[0].version,'9.0.0')
 const admin=await(await f.call('/api/admin/catalog')).json()
 assert.equal(admin.items[0].version,'1.0.0');assert.equal(admin.items[0].npmLatestVersion,'9.0.0')
 assert.equal(f.entry().state,'published');assert.equal(f.entry().revision,revision)
 assert.equal(JSON.parse(f.db.prepare('SELECT metadata FROM market_plugins').get().metadata).version,'1.0.0')
 await f.change('archive')
 const before=calls
 assert.deepEqual(await f.publicList(),[]);assert.equal(calls,before)
})

test('npm links resolve to package identities, never arbitrary fetch destinations', () => {
 assert.deepEqual(npmReference('https://www.npmjs.com/package/tokens-cowork-finance'),{name:'tokens-cowork-finance',version:'latest'})
 assert.deepEqual(npmReference('https://npmjs.com/package/@fixture/tool/v/0.1.0-beta.1?activeTab=readme'),{name:'@fixture/tool',version:'0.1.0-beta.1'})
 assert.deepEqual(npmReference(' https://www.npmjs.com/package/@fixture%2Ftool/ ', '1.0.0'),{name:'@fixture/tool',version:'1.0.0'})
 for(const input of ['https://npmjs.com.evil.test/package/tool','https://user:secret@npmjs.com/package/tool','http://npmjs.com/package/tool','https://npmjs.com:8443/package/tool','https://npmjs.com/package/tool/extra','https://npmjs.com/package/%ZZ','https://npmjs.com/package/tool/v/../../other'])assert.throws(()=>npmReference(input))
})
test('npm import fills a prerelease draft without inventing a repository or license approval', async t => {
 t.mock.method(globalThis,'fetch',async url=>{
  assert.equal(url,'https://registry.npmjs.org/tokens-cowork-finance/latest')
  return Response.json({name:'tokens-cowork-finance',version:'0.1.0-beta.1',description:'Fixture finance tool',license:'UNLICENSED'})
 })
 const p=await npmPackage('https://www.npmjs.com/package/tokens-cowork-finance')
 assert.equal(p.suggestedId,'tokens-cowork-finance');assert.equal(p.repository,'');assert.equal(p.prerelease,true);assert.equal(p.license,'UNLICENSED')
 const f=fixture(t)
 assert.equal((await f.change('create',{metadata:{...p,id:m.id}})).status,200)
 assert.equal(f.entry().state,'draft');assert.deepEqual(await f.publicList(),[])
 assert.equal((await f.publish()).status,400)
})
test('repository is optional for npm and omitted from the public contract when absent', async t => {
 const f=fixture(t)
 assert.equal((await f.change('create',{metadata:{...m,repository:''}})).status,200)
 assert.equal((await f.publish()).status,200)
 const page=await(await f.call('/v1/plugins',undefined,'')).json()
 assert.equal(page.items[0].repository,undefined)
 assert.equal(page.items[0].homepage,'https://www.npmjs.com/package/'+m.package)
 assert.equal((await f.change('edit',{metadata:{...m,npm:false,repository:'',installSource:{commit:'a'.repeat(40)}}})).status,400)
})
test('versions accept exact prereleases but reject ranges, invalid identifiers and whitespace', () => {
 for(const value of ['0.1.0-beta.1','1.0.0-rc.1+build.3','1.0.0','1.0.0+build'])assert.equal(versionOK(value),true,value)
 for(const value of ['^1.0.0','latest','1.0','01.0.0','1.0.0-01','1.0.0-','1.0.0\n','1.0.0-beta..1','1.0.0+' ])assert.equal(versionOK(value),false,value)
})
test('first publication resolves stable npm latest without manually refreshing an older draft',async t=>{
 const f=fixture(t)
 await f.change('create',{metadata:{...m,version:'0.1.0-beta.1'}})
 t.mock.method(globalThis,'fetch',async()=>Response.json({latest:'1.0.0'}))
 assert.equal((await f.publish()).status,200)
 assert.equal(f.entry().state,'published')
 assert.equal(JSON.parse(f.db.prepare('SELECT metadata FROM market_plugins').get().metadata).version,'1.0.0')
})
test('npm import rejects a mismatched explicit version',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({name:m.package,version:'9.0.0'}))
 await assert.rejects(()=>npmPackage(m.package,'1.0.0'))
})

test('purge requires trash state, matching ID, authentication and a fresh revision',async t=>{
 const f=fixture(t);await f.create()
 assert.equal((await f.change('purge',{confirmId:m.id})).status,409)
 await f.change('trash');const revision=f.entry().revision
 assert.equal((await f.change('purge',{confirmId:'wrong'})).status,400)
 assert.equal((await f.change('purge',{confirmId:m.id,revision:revision-1})).status,409)
 assert.equal((await f.call('/api/admin/catalog',{operation:'purge',id:m.id,revision,confirmId:m.id},'')).status,401)
 assert.equal((await f.call('/api/admin/catalog',{operation:'purge',id:m.id,revision,confirmId:m.id},'fixture-admin','https://evil.test')).status,403)
 assert.equal(f.entry().state,'deleted')
})

test('purge atomically removes only plugin metadata and grants, keeps audit and shared identities',async t=>{
 const f=fixture(t);await f.create()
 f.db.prepare('INSERT INTO market_plugins(id,visibility,metadata) VALUES(?,?,?)').run('other-tool','public',JSON.stringify({...m,id:'other-tool'}))
 f.db.exec("INSERT INTO market_keys VALUES('shared-fingerprint','fixture',1,NULL); INSERT INTO market_organizations VALUES(101,'Fixture Org',1)")
 for(const id of [m.id,'other-tool']){
  f.db.prepare('INSERT INTO market_org_policies VALUES(?)').run(id)
  f.db.prepare('INSERT INTO market_org_grants VALUES(?,101)').run(id)
  f.db.prepare("INSERT INTO market_plugin_key_grants VALUES(?,'shared-fingerprint')").run(id)
  f.db.prepare("INSERT INTO market_plugin_key_values VALUES(?,'shared-fingerprint','fixture-ciphertext')").run(id)
  f.db.prepare("INSERT INTO market_grants VALUES('shared-fingerprint',?)").run(id)
 }
 await f.change('trash')
 assert.equal((await f.change('purge',{confirmId:m.id})).status,200)
 assert.equal(f.entry(),undefined)
 assert.equal(f.db.prepare('SELECT * FROM market_plugins WHERE id=?').get(m.id),undefined)
 for(const table of ['market_org_policies','market_org_grants','market_plugin_key_grants','market_plugin_key_values','market_grants']){
  assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table} WHERE plugin_id=?`).get(m.id).n,0)
  assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table} WHERE plugin_id='other-tool'`).get().n,1)
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM market_keys').get().n,1)
 assert.equal(f.db.prepare('SELECT count(*) n FROM market_organizations').get().n,1)
 assert.equal(f.db.prepare("SELECT count(*) n FROM market_admin_audit WHERE action='catalog.purge' AND target=?").get(m.id).n,1)
 assert.equal((await f.change('restore')).status,404)
 assert.equal((await f.create()).status,200)
 assert.equal(f.entry().state,'draft')
})

test('purge rolls back when audit fails or another operation wins the revision race',async t=>{
 const f=fixture(t);await f.create();await f.change('trash')
 f.db.exec("CREATE TRIGGER fail_purge BEFORE INSERT ON market_admin_audit WHEN NEW.action='catalog.purge' BEGIN SELECT RAISE(ABORT,'fixture'); END")
 assert.equal((await f.change('purge',{confirmId:m.id})).status,503)
 assert.equal(f.entry().state,'deleted')
 f.db.exec('DROP TRIGGER fail_purge')
 const batch=f.env.MARKET_DB.batch
 f.env.MARKET_DB.batch=async statements=>{f.db.prepare("UPDATE market_catalog SET revision=revision+1,state='draft' WHERE id=?").run(m.id);return batch(statements)}
 assert.equal((await f.change('purge',{confirmId:m.id})).status,409)
 assert.equal(f.entry().state,'draft')
 assert.ok(f.db.prepare('SELECT * FROM market_plugins WHERE id=?').get(m.id))
})

test('a self-hosted package readable anonymously publishes as public; the private-scope one is refused',async t=>{
 const f=fixture(t)
 Object.assign(f.env,{MARKET_PRIVATE_REGISTRY_ENABLED:'true',MARKET_PRIVATE_REGISTRY_URL:'https://registry.example.test/',MARKET_PRIVATE_REGISTRY_TOKEN:'market:s3cret',MARKET_PRIVATE_REGISTRY_AUTH_SCHEME:'basic'})
 // Only the private scope refuses anonymous readers; the source itself says nothing.
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const name=decodeURIComponent(new URL(url).pathname.slice(1))
  if(name.startsWith('@fixture-private/')&&!('Authorization' in options.headers))return new Response('unauthorized',{status:401})
  return Response.json({name,'dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name,version:'1.0.0',dist:{tarball:'https://registry.example.test/x-1.0.0.tgz'}}}})
 })
 assert.equal((await f.change('create',{metadata:{...m,registry:'tokenscowork'}})).status,200)
 assert.equal((await f.publish()).status,200)
 assert.equal(f.db.prepare('SELECT visibility FROM market_plugins WHERE id=?').get(m.id).visibility,'public')
 const hidden={...m,id:'hidden-tool',package:'@fixture-private/new-tool',registry:'tokenscowork'}
 const revision=()=>f.db.prepare('SELECT revision FROM market_catalog WHERE id=?').get(hidden.id).revision
 assert.equal((await f.call('/api/admin/catalog',{operation:'create',id:hidden.id,metadata:hidden})).status,200)
 assert.equal((await f.call('/api/admin/catalog',{operation:'publish',id:hidden.id,revision:revision(),confirmPublic:true})).status,409)
 assert.equal(f.db.prepare('SELECT state FROM market_catalog WHERE id=?').get(hidden.id).state,'draft')
})
