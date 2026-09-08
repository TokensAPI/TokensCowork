import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import worker from '../_worker.js'
import { fingerprint } from '../server/security/key-fingerprint.js'

const metadata = { id: 'private-tool', package: '@example/tool', displayName: '工具', summary: '企业工具', repository: 'https://example.com/repo', version: '1.0.0', npm: false }
test('public admin entry and split assets remain reachable after directory refactor',async t=>{
  const {call}=fixture(t)
  for(const path of ['/admin/','/admin/index.html','/admin/access.html','/admin/assets/market-admin.js','/admin/assets/market-api.js','/admin/assets/market-admin.css','/source.json']){
    assert.equal((await call(path)).status,200,path)
  }
  for(const path of ['/admin/organization-ui.js','/admin/status-ui.js','/admin/assets/unknown.js','/%73erver/security/admin-session.js']){
    assert.equal((await call(path)).status,404,path)
  }
})
test('session persists across requests, blocks CSRF and is revoked on logout',async t=>{
  const {env,db}=fixture(t)
  const call=(path,method='GET',cookie='',origin='https://market.example',data={})=>worker.fetch(new Request('https://market.example/api/admin/'+path,{method,headers:{Cookie:cookie,Origin:origin},...(method==='PUT'?{body:JSON.stringify(data)}:{})}),env,{})
  assert.equal((await call('login','PUT','','https://evil.example',{credential:'admin-secret'})).status,403)
  assert.equal((await call('login','PUT','','https://market.example',{credential:'wrong'})).status,401)
  const login=await call('login','PUT','','https://market.example',{credential:'admin-secret'})
  assert.equal(login.status,200)
  const header=login.headers.get('set-cookie'),cookie=header.split(';')[0]
  for(const flag of ['HttpOnly','Secure','SameSite=Strict','Max-Age=604800'])assert.ok(header.includes(flag))
  assert.ok(!header.includes('admin-secret'))
  assert.notEqual(db.prepare('SELECT token_hash FROM market_admin_sessions').get().token_hash,cookie.split('=')[1])
  for(let i=0;i<2;i++)assert.equal((await call('access','GET',cookie)).status,200)
  assert.equal((await call('organizations','PUT',cookie,'https://evil.example',{id:1,name:'Org',enabled:true})).status,403)
  assert.equal((await call('organizations','PUT',cookie,'',{id:1,name:'Org',enabled:true})).status,403)
  assert.equal((await call('organizations','PUT',cookie,'https://market.example',{id:1,name:'Org',enabled:true})).status,200)
  const logout=await call('logout','PUT',cookie)
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'))
  assert.equal((await call('access','GET',cookie)).status,401)
})
test('expired and password-invalidated sessions fail closed',async t=>{
  const {env,db}=fixture(t)
  const login=()=>worker.fetch(new Request('https://market.example/api/admin/login',{method:'PUT',headers:{Origin:'https://market.example'},body:JSON.stringify({credential:env.MARKET_ADMIN_TOKEN})}),env,{})
  const check=cookie=>worker.fetch(new Request('https://market.example/api/admin/access',{headers:{Cookie:cookie}}),env,{})
  let cookie=(await login()).headers.get('set-cookie').split(';')[0]
  db.exec('UPDATE market_admin_sessions SET expires_at=0')
  assert.equal((await check(cookie)).status,401)
  cookie=(await login()).headers.get('set-cookie').split(';')[0]
  env.MARKET_ADMIN_TOKEN='new-password'
  assert.equal((await check(cookie)).status,401)
  assert.equal((await check('__Host-market_session='+'a'.repeat(64))).status,401)
})
test('complete Keys are encrypted at rest, admin-only, retained and erased with grants',async t=>{
  const {call,db}=fixture(t)
  const save=(apiKeys,keepFingerprints=[])=>call('/api/admin/plugin-access','admin-secret',{id:metadata.id,metadata,organizationIds:[],apiKeys,keepFingerprints,confirmPublic:true})
  assert.equal((await save(['sk-new-secret'])).status,200)
  const endpoint='/api/admin/plugin-key-values?id='+metadata.id
  for(const key of [undefined,'wrong-password','sk-new-secret']){
    const response=await call(endpoint,key)
    assert.equal(response.status,401);assert.ok(!(await response.text()).includes('sk-new-secret'))
  }
  const ciphertext=db.prepare('SELECT encrypted_value FROM market_plugin_key_values').get().encrypted_value
  assert.ok(!ciphertext.includes('sk-new-secret'))
  const response=await call(endpoint,'admin-secret')
  assert.equal(response.headers.get('cache-control'),'no-store')
  const values=(await response.json()).keys
  assert.equal(values[0].apiKey,'sk-new-secret')
  assert.ok(!(await (await call('/api/admin/access','admin-secret')).text()).includes('sk-new-secret'))
  assert.ok(!(await (await call('/roster.json','sk-new-secret')).text()).includes('sk-new-secret'))
  assert.equal((await save([],[values[0].fingerprint])).status,200)
  assert.equal((await (await call(endpoint,'admin-secret')).json()).keys[0].apiKey,'sk-new-secret')
  assert.equal((await save([])).status,200)
  assert.equal(db.prepare('SELECT count(*) AS n FROM market_plugin_key_values').get().n,0)
})
test('old fingerprint grants remain valid and re-entry backfills full Key without duplication',async t=>{
  const {call,db}=fixture(t),fp=await fingerprint('sk-previous','separate-secret')
  await call('/api/admin/plugin-access','admin-secret',{id:metadata.id,metadata,organizationIds:[],apiKeys:['sk-previous'],keepFingerprints:[]})
  db.exec('DELETE FROM market_plugin_key_values')
  assert.equal((await (await call('/api/admin/plugin-key-values?id='+metadata.id,'admin-secret')).json()).keys.length,0)
  assert.equal((await (await call('/roster.json','sk-previous')).json()).items.length,1)
  assert.equal((await call('/api/admin/plugin-access','admin-secret',{id:metadata.id,metadata,organizationIds:[],apiKeys:['sk-previous'],keepFingerprints:[fp]})).status,200)
  assert.equal(db.prepare('SELECT count(*) AS n FROM market_plugin_key_grants').get().n,1)
  assert.equal((await (await call('/api/admin/plugin-key-values?id='+metadata.id,'admin-secret')).json()).keys[0].apiKey,'sk-previous')
})
test('missing encryption secret or tampered ciphertext fails closed without leaking Keys',async t=>{
  const {call,env,db}=fixture(t)
  const data={id:metadata.id,metadata,organizationIds:[],apiKeys:['sk-secret'],keepFingerprints:[]}
  delete env.MARKET_KEY_ENCRYPTION_SECRET
  assert.equal((await call('/api/admin/plugin-access','admin-secret',data)).status,503)
  assert.equal(db.prepare('SELECT count(*) AS n FROM market_plugins').get().n,0)
  env.MARKET_KEY_ENCRYPTION_SECRET='restored'
  assert.equal((await call('/api/admin/plugin-access','admin-secret',data)).status,200)
  db.exec("UPDATE market_plugin_key_values SET encrypted_value='00.00'")
  assert.equal((await call('/api/admin/plugin-key-values?id='+metadata.id,'admin-secret')).status,503)
})
test('built-in classification cannot be bypassed by editing request metadata',async t=>{
  const {env,call,db}=fixture(t)
  env.ASSETS.fetch=async()=>Response.json({publisher:{name:'Example'},items:[{...metadata,category:'builtin'}]})
  for(const path of ['/api/admin/plugins','/api/admin/plugin-keys','/api/admin/plugin-organizations','/api/admin/plugin-access']) {
    assert.equal((await call(path,'admin-secret',{id:metadata.id,metadata:{...metadata,category:'optional'},visibility:'restricted',organizationIds:[],apiKeys:['sk-direct'],keepFingerprints:[]})).status,409)
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM market_plugins').get().n,0)
})
test('roster built-ins match components assembled into the desktop patch',()=>{
  const roster=JSON.parse(readFileSync(new URL('../roster.json',import.meta.url),'utf8'))
  const product=JSON.parse(readFileSync(new URL('../../product.json',import.meta.url),'utf8'))
  assert.ok(roster.items.every(p=>['builtin','optional'].includes(p.category)))
  assert.deepEqual(roster.items.filter(p=>p.category==='builtin').map(p=>p.id).sort(),product.plugins.filter(p=>p.enabledByDefault&&p.patch).map(p=>p.id).sort())
})
test('mixed grants allow organization OR direct Key and revoke independently', async t => {
  const {call,env}=fixture(t)
  await call('/api/admin/organizations','admin-secret',{id:1,name:'Org',enabled:true})
  env.MARKET_ORGANIZATIONS={resolveOrganization:async key=>({id:key==='sk-org'?1:2,name:'Org'})}
  const save=(organizationIds,apiKeys=[],keepFingerprints=[],confirmPublic=false)=>call('/api/admin/plugin-access','admin-secret',{id:metadata.id,metadata,organizationIds,apiKeys,keepFingerprints,confirmPublic,objectKey:'private/tool.tgz'})
  assert.equal((await save([1],['sk-direct'])).status,200)
  for(const key of ['sk-org','sk-direct','sk-other']) {
    assert.equal((await call('/downloads/private-tool',key)).status,key==='sk-other'?403:200)
  }
  const state=await (await call('/api/admin/access','admin-secret')).json()
  assert.ok(!JSON.stringify(state).includes('sk-direct'))
  const fp=state.directKeyGrants[0].fingerprint
  assert.equal((await save([],[],[fp])).status,200)
  delete env.MARKET_ORGANIZATIONS
  assert.equal((await call('/downloads/private-tool','sk-direct')).status,200)
  assert.equal((await (await call('/roster.json','sk-direct')).json()).items.length,1)
  assert.equal((await save([])).status,409)
  assert.equal((await save([1])).status,200)
  assert.equal((await save([],[],[fp])).status,400)
  assert.equal((await save([],[],[],true)).status,200)
  assert.equal((await call('/downloads/private-tool')).status,200)
})
test('direct Key remains usable when another plugin requires unavailable organization provider',async t=>{
  const {call}=fixture(t)
  await call('/api/admin/organizations','admin-secret',{id:1,name:'Org',enabled:true})
  await call('/api/admin/plugin-access','admin-secret',{id:metadata.id,metadata,organizationIds:[],apiKeys:['sk-direct'],keepFingerprints:[]})
  const second={...metadata,id:'org-only'}
  await call('/api/admin/plugin-access','admin-secret',{id:second.id,metadata:second,organizationIds:[1],apiKeys:[],keepFingerprints:[]})
  assert.deepEqual((await (await call('/roster.json','sk-direct')).json()).items.map(p=>p.id),[metadata.id])
  assert.equal((await call('/downloads/org-only','sk-direct')).status,503)
})
test('old open flag no longer bypasses login and cross-origin writes stay rejected',async t=>{
  const {call,env}=fixture(t)
  assert.equal((await call('/api/admin/roster')).status,401)
  env.MARKET_ADMIN_MODE='open'
  assert.equal((await call('/api/admin/access')).status,401)
  assert.equal((await call('/api/admin/roster')).status,401)
  assert.equal((await call('/api/admin/organizations',undefined,{id:1,name:'Org',enabled:true})).status,401)
  const response=await worker.fetch(new Request('https://market.example/api/admin/organizations',{method:'PUT',headers:{Origin:'https://evil.example',Authorization:'Bearer admin-secret'},body:JSON.stringify({id:2,name:'Other',enabled:true})}),env,{})
  assert.equal(response.status,403)
})
test('legacy Key can be explicitly retained only before migration',async t=>{
  const {call,restrict,grant}=fixture(t);await restrict();await grant()
  const fp=await fingerprint('sk-customer-a','separate-secret')
  const save=keepFingerprints=>call('/api/admin/plugin-access','admin-secret',{id:metadata.id,metadata,organizationIds:[],apiKeys:[],keepFingerprints,confirmPublic:true})
  assert.equal((await save([fp])).status,200)
  assert.equal((await save([])).status,200)
  assert.equal((await save([fp])).status,400)
})
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../database/migrations/001-market-access.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../database/migrations/002-organizations-keys-sessions.sql', import.meta.url), 'utf8'))
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values), all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const env = { MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret', MARKET_KEY_ENCRYPTION_SECRET:'test-encryption-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } },
    MARKET_PACKAGES: { get: async () => ({ body: 'private package' }) },
    ASSETS: { fetch: async () => Response.json({ publisher: { name: 'Example' }, items: [metadata] }) } }
  const call = (path, key, data) => worker.fetch(new Request('https://market.example'+path, { method: data ? 'PUT' : 'GET', headers: key ? { Authorization: `Bearer ${key}` } : {}, ...(data ? { body: JSON.stringify(data) } : {}) }), env, {})
  const restrict = () => call('/api/admin/plugins', 'admin-secret', { id: metadata.id, metadata, visibility: 'restricted', objectKey: 'private/tool.tgz' })
  const grant = (enabled = true, expiresAt = null) => call('/api/admin/keys', 'admin-secret', { apiKey: 'sk-customer-a', label: '企业 A', enabled, expiresAt, plugins: [metadata.id] })
  return { db, env, call, restrict, grant }
}
test('admin endpoints reject unauthenticated and customer credentials', async t => {
  const { call } = fixture(t)
  for (const key of [undefined, 'sk-customer-a']) assert.equal((await call('/api/admin/access', key)).status, 401)
})

test('maintenance scripts and tests are not public assets', async t => {
  const { call } = fixture(t)
  for (const path of ['/scripts/schema.sql','/tests/access.test.mjs','/%73cripts/schema.sql','/server/market-worker.js','/server/security/key-vault.js','/database/migrations/001-market-access.sql','/ops/market-copy-admin-token.ps1','/legacy/admin/market-access.js','/roster-not-public.json','/package.json','/README.md','/source.config.json']) {
    assert.equal((await call(path)).status, 404)
  }
})
test('restricted catalog, roster and download require matching grant, not just any key', async t => {
  const { call, restrict, grant, db } = fixture(t)
  assert.equal((await restrict()).status, 200); assert.equal((await grant()).status, 200)
  for (const key of [undefined, 'sk-other', 'sk-customer-a']) {
    for (const path of ['/v1/plugins', '/v1/plugins/', '/roster.json']) {
      const r = await call(path, key); assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.equal((await r.json()).items.length, key === 'sk-customer-a' ? 1 : 0)
    }
    assert.equal((await call('/downloads/private-tool', key)).status, key === 'sk-customer-a' ? 200 : 403)
  }
  const state = await (await call('/api/admin/access', 'admin-secret')).text()
  assert.ok(!state.includes('sk-customer-a'))
  assert.equal(db.prepare('SELECT fingerprint FROM market_keys').get().fingerprint.length, 64)
})
test('revocation and expiry deny both catalog and download immediately', async t => {
  const { call, restrict, grant } = fixture(t); await restrict(); await grant()
  for (const [enabled, expiry] of [[false, null], [true, Date.now()-1000]]) {
    await grant(enabled, expiry)
    assert.equal((await (await call('/v1/plugins', 'sk-customer-a')).json()).items.length, 0)
    assert.equal((await call('/downloads/private-tool', 'sk-customer-a')).status, 403)
  }
})
test('database errors never fall back to unrestricted static catalog', async t => {
  const { env, call } = fixture(t)
  env.MARKET_DB.prepare = () => { throw new Error('database unavailable') }
  assert.equal((await call('/v1/plugins')).status, 503)
  assert.equal((await call('/roster.json')).status, 503)
  assert.equal((await call('/downloads/private-tool', 'sk-customer-a')).status, 503)
})
test('public plugin stays public; unconfigured download is rejected', async t => {
  const { call } = fixture(t)
  await call('/api/admin/plugins', 'admin-secret', { id: metadata.id, metadata, visibility: 'public' })
  assert.equal((await (await call('/v1/plugins')).json()).items.length, 1)
  assert.equal((await call('/downloads/private-tool')).status, 404)
})
test('malformed fields and unknown fingerprints cannot overwrite authorization', async t => {
  const { call } = fixture(t)
  assert.equal((await call('/api/admin/keys', 'admin-secret', { fingerprint: 'a'.repeat(64), label:'test', enabled:true, plugins:[] })).status, 400)
  assert.equal((await call('/api/admin/plugins', 'admin-secret', { id: metadata.id, metadata: { ...metadata, repository: 'javascript:alert(1)' }, visibility: 'restricted' })).status, 400)
})
test('HMAC fingerprint depends on server secret', async () => {
  assert.notEqual(await fingerprint('sk-test','one'), await fingerprint('sk-test','two'))
})

test('organization policy shares access across Keys, isolates organizations and uses the same download gate', async t => {
  const { call, env, db } = fixture(t)
  for (const id of [1,2]) assert.equal((await call('/api/admin/organizations','admin-secret',{id,name:'Org '+id,enabled:true})).status,200)
  let lookups = 0
  env.MARKET_ORGANIZATIONS = {resolveOrganization: async key => { lookups++; return key==='sk-revoked'?null:{id:key==='sk-other'?2:1,name:'Org'} }}
  const configure = (organizationIds, confirmPublic=false) => call('/api/admin/plugin-organizations','admin-secret',{id:metadata.id,metadata,organizationIds,confirmPublic,objectKey:'private/tool.tgz'})
  assert.equal((await configure([1])).status,200)
  for (const key of [undefined,'sk-first','sk-second','sk-other','sk-revoked']) {
    const authorized = ['sk-first','sk-second'].includes(key)
    assert.equal((await (await call('/roster.json',key)).json()).items.length,authorized?1:0)
    assert.equal((await call('/downloads/private-tool',key)).status,authorized?200:403)
  }
  // An untrusted client-supplied organization never overrides the provider.
  assert.equal((await (await call('/roster.json?organizationId=1','sk-other')).json()).items.length,0)
  // Multiple restricted plugins cause only one identity lookup per catalog request.
  const second={...metadata,id:'another-tool'}
  await call('/api/admin/plugin-organizations','admin-secret',{id:second.id,metadata:second,organizationIds:[1]})
  lookups=0; await call('/roster.json','sk-first'); assert.equal(lookups,1)
  await call('/api/admin/organizations','admin-secret',{id:1,name:'Renamed',enabled:false})
  assert.equal((await (await call('/roster.json','sk-first')).json()).items.length,0)
  assert.equal((await configure([])).status,409)
  assert.equal((await configure([],true)).status,200)
  assert.equal(db.prepare('SELECT visibility FROM market_plugins WHERE id=?').get(metadata.id).visibility,'public')
})

test('organization migration keeps legacy restrictions until saved and never falls back to old Key grants', async t => {
  const { call, env, restrict, grant }=fixture(t)
  await restrict(); await grant()
  await call('/api/admin/organizations','admin-secret',{id:7,name:'Org',enabled:true})
  assert.equal((await (await call('/roster.json','sk-customer-a')).json()).items.length,1)
  await call('/api/admin/plugin-organizations','admin-secret',{id:metadata.id,metadata,organizationIds:[7]})
  assert.equal((await call('/roster.json','sk-customer-a')).status,503)
  assert.equal((await call('/downloads/private-tool','sk-customer-a')).status,503)
  assert.equal((await (await call('/roster.json')).json()).items.length,0)
  assert.equal((await restrict()).status,409)
  env.MARKET_ORGANIZATIONS={resolveOrganization:async()=>({id:8,name:'Different'})}
  assert.equal((await (await call('/roster.json','sk-customer-a')).json()).items.length,0)
  env.MARKET_ORGANIZATIONS.resolveOrganization=async()=>{throw new Error('upstream failed')}
  assert.equal((await call('/roster.json','sk-customer-a')).status,503)
  env.MARKET_ORGANIZATIONS.resolveOrganization=async()=>({id:'7',name:'Invalid'})
  assert.equal((await call('/roster.json','sk-customer-a')).status,503)
})

test('organization administration rejects invalid input and never exposes organization lists to customers', async t => {
  const {call}=fixture(t)
  for(const id of [0,-1,1.1,'1',9007199254740992]) assert.equal((await call('/api/admin/organizations','admin-secret',{id,name:'Org',enabled:true})).status,400)
  assert.equal((await call('/api/admin/organizations','sk-customer',{id:1,name:'Org',enabled:true})).status,401)
  assert.equal((await call('/api/admin/plugin-organizations','admin-secret',{id:metadata.id,metadata,organizationIds:[999]})).status,400)
  const state=await (await call('/api/admin/access','admin-secret')).json()
  assert.equal(state.organizationProviderReady,false)
  assert.deepEqual(state.organizations,[])
})

test('organization sync is admin-only, atomic and preserves locally disabled organizations', async t => {
  const {call,env,db}=fixture(t)
  assert.equal((await call('/api/admin/organizations/sync','sk-customer',{})).status,401)
  assert.equal((await call('/api/admin/organizations/sync','admin-secret',{})).status,503)
  await call('/api/admin/organizations','admin-secret',{id:1,name:'Old',enabled:false})
  env.MARKET_ORGANIZATIONS={listOrganizations:async()=>[{id:1,name:'New'},{id:2,name:'Second'}]}
  assert.equal((await call('/api/admin/organizations/sync','admin-secret',{})).status,200)
  assert.equal(db.prepare('SELECT enabled FROM market_organizations WHERE id=1').get().enabled,0)
  env.MARKET_ORGANIZATIONS.listOrganizations=async()=>[{id:3,name:'Third'},{id:2,name:123}]
  assert.equal((await call('/api/admin/organizations/sync','admin-secret',{})).status,503)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_organizations').get().n,2)
})

test('per-plugin Key editor restricts, retains, replaces and clears without changing other plugins', async t => {
  const { call, db } = fixture(t)
  const save = (apiKeys, keepFingerprints = []) => call('/api/admin/plugin-keys', 'admin-secret', { id:metadata.id, metadata, apiKeys, keepFingerprints })
  assert.equal((await save(['sk-first', 'sk-second'])).status, 200)
  assert.equal((await (await call('/roster.json')).json()).items.length, 0)
  assert.equal((await (await call('/roster.json','sk-first')).json()).items.length, 1)
  const fp = await fingerprint('sk-first','separate-secret')
  db.prepare('INSERT INTO market_grants(fingerprint,plugin_id) VALUES(?,?)').run(fp,'another-plugin')
  assert.equal((await save(['sk-third'],[fp])).status, 200)
  assert.equal((await (await call('/roster.json','sk-second')).json()).items.length, 0)
  assert.equal((await (await call('/roster.json','sk-third')).json()).items.length, 1)
  assert.equal((await save(['bad-key'])).status, 400)
  assert.equal((await save([],['f'.repeat(64)])).status, 400)
  assert.equal((await save([])).status, 200)
  assert.equal((await (await call('/roster.json')).json()).items.length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_grants WHERE plugin_id=?').get('another-plugin').n, 1)
  assert.ok(!(await (await call('/api/admin/access','admin-secret')).text()).includes('sk-first'))
})
test('required authorization configuration fails closed when database binding is missing', async t => {
  const { env, call } = fixture(t)
  env.MARKET_ACCESS_REQUIRED = 'true'; delete env.MARKET_DB
  for (const path of ['/v1/plugins','/roster.json','/downloads/private-tool']) assert.equal((await call(path)).status, 503)
})
test('cross-origin writes and oversized JSON are rejected', async t => {
  const { env } = fixture(t)
  const request = (origin, body) => new Request('https://market.example/api/admin/keys', { method:'PUT', headers:{ Authorization:'Bearer admin-secret', origin }, body })
  assert.equal((await worker.fetch(request('https://attacker.example','{}'), env, {})).status, 403)
  assert.equal((await worker.fetch(request('https://market.example', ' '.repeat(17000)), env, {})).status, 400)
})
