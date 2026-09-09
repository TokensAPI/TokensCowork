import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createTokensApiOrganizations} from '../server/integrations/tokensapi-organizations.js'
const env={MARKET_ORGANIZATIONS_BASE_URL:'https://tokensapi.ai',MARKET_ORGANIZATIONS_TOKEN:'fixture-management-token'}
const response=data=>Response.json({success:true,message:'',data})

test('key validation distinguishes successful personal Keys from authentication rejection',async()=>{
  for(const [reply,status] of [
    [()=>response({organization:null}),'valid'],
    [()=>new Response('sensitive upstream body',{status:401}),'invalid'],
    [()=>new Response('sensitive upstream body',{status:403}),'disabled'],
    [()=>response({organization:{id:8,name:'Team',status:0}}),'disabled'],
  ]){
    const source=createTokensApiOrganizations(env,async()=>reply())
    assert.deepEqual(await source.validateApiKey('sk-fixture'),{status,organization:null})
  }
  const source=createTokensApiOrganizations(env,async()=>new Response('offline',{status:503}))
  await assert.rejects(()=>source.validateApiKey('sk-fixture'))
})
test('identity uses customer credentials and discards role and quota fields',async()=>{
  const source=createTokensApiOrganizations(env,async(url,options)=>{
    assert.equal(url,'https://tokensapi.ai/api/current/organization')
    assert.equal(options.headers.Authorization,'Bearer sk-fixture')
    assert.equal(options.redirect,'manual');assert.equal(options.headers['Cache-Control'],'no-store');assert.equal(options.cache,undefined)
    assert.ok(options.signal instanceof AbortSignal)
    return response({organization:{id:8,name:'Team',status:1,my_role:100,used_quota:123}})
  })
  assert.deepEqual(await source.resolveOrganization('sk-fixture'),{id:8,name:'Team'})
})
test('personal Key, disabled organization and denied identities grant no organization access',async()=>{
  for(const reply of [()=>response({organization:null}),()=>response({organization:{id:8,name:'Team',status:0}}),()=>Response.json({error:{}},{status:401}),()=>Response.json({error:{}},{status:403})]){
    assert.equal(await createTokensApiOrganizations(env,async()=>reply()).resolveOrganization('sk-fixture'),null)
  }
})
test('full list uses independent server token and supports empty lists',async()=>{
  const source=createTokensApiOrganizations(env,async(url,options)=>{
    assert.equal(url,'https://tokensapi.ai/api/organizations/all')
    assert.equal(options.headers.Authorization,'Bearer fixture-management-token')
    return response([{id:2,name:'Two'},{id:1,name:'One'}])
  })
  assert.deepEqual(await source.listOrganizations(),[{id:2,name:'Two'},{id:1,name:'One'}])
  assert.deepEqual(await createTokensApiOrganizations(env,async()=>response([])).listOrganizations(),[])
})
test('configuration cannot send credentials to arbitrary origins',()=>{
  for(const base of [undefined,'http://tokensapi.ai','https://tokensapi.ai.evil.example','https://tokensapi.ai/redirect']){
    assert.equal(createTokensApiOrganizations({MARKET_ORGANIZATIONS_BASE_URL:base}),null)
  }
  const source=createTokensApiOrganizations({MARKET_ORGANIZATIONS_BASE_URL:env.MARKET_ORGANIZATIONS_BASE_URL})
  assert.equal(typeof source.resolveOrganization,'function');assert.equal(source.listOrganizations,undefined)
})
test('malformed identity responses fail closed',async()=>{
  for(const data of [{},{organization:{}},{organization:{id:'1',name:'Org',status:1}},{organization:{id:1,name:'Org'}},{organization:{id:1,name:'Org',status:'1'}}]){
    await assert.rejects(()=>createTokensApiOrganizations(env,async()=>response(data)).resolveOrganization('sk-fixture'))
  }
  for(const reply of [()=>Response.json({success:false,data:{organization:null}}),()=>new Response('unavailable',{status:500}),()=>new Response('rate limited',{status:429}),()=>new Response('invalid JSON')]){
    await assert.rejects(()=>createTokensApiOrganizations(env,async()=>reply()).resolveOrganization('sk-fixture'))
  }
})
test('invalid or unauthorized lists never become empty successful syncs',async()=>{
  for(const data of [{},[{id:1,name:'One'},{id:1,name:'Duplicate'}],[{id:-1,name:'Invalid'}]]){
    await assert.rejects(()=>createTokensApiOrganizations(env,async()=>response(data)).listOrganizations())
  }
  await assert.rejects(()=>createTokensApiOrganizations(env,async()=>Response.json({success:false},{status:401})).listOrganizations())
})
test('transport errors are sanitized and response body size is bounded',async()=>{
  await assert.rejects(()=>createTokensApiOrganizations(env,async()=>{throw new Error('fixture-management-token')}).listOrganizations(),error=>!error.message.includes('fixture-management-token'))
  await assert.rejects(()=>createTokensApiOrganizations(env,async()=>new Response('x'.repeat(2*1024*1024+1))).listOrganizations())
})
test('redirects are rejected without forwarding credentials',async()=>{
  let requests=0
  const source=createTokensApiOrganizations(env,async(url,options)=>{
    requests++;assert.equal(options.redirect,'manual')
    return new Response(null,{status:302,headers:{Location:'https://untrusted.example'}})
  })
  await assert.rejects(()=>source.listOrganizations(),error=>error.providerCode==='HTTP_302')
  assert.equal(requests,1)
})
