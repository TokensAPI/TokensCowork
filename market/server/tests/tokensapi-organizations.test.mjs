import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createTokensApiOrganizations} from '../integrations/tokensapi-organizations.js'
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
    assert.deepEqual(await source.validateApiKey('sk-fixture'),{status,organization:null,user:null})
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
test('console login sends the pasted token and the account id it needs',async()=>{
  const seen=[]
  const source=createTokensApiOrganizations(env,async(url,options)=>{
    seen.push(url)
    // The pasted token, the id TokensAPI demands beside it, and no management token alongside.
    assert.equal(options.headers.Authorization,'fixture-token')
    assert.equal(options.headers['New-Api-User'],'5001')
    assert.equal(options.headers.Cookie,undefined)
    assert.equal(options.redirect,'manual')
    return url.endsWith('/api/user/self')
      ?response({id:5001,username:'owner',display_name:' 组织所有者 ',role:100,quota:9})
      // GetMyOrg answers at the top level of data, unlike the API-key endpoint's wrapper.
      :response({id:8,name:'Team',status:1,my_role:10,member_id:3})
  })
  const credential={accessToken:'fixture-token',userId:5001}
  assert.deepEqual(await source.resolveAccount(credential),{id:5001,username:'owner',displayName:'组织所有者'})
  assert.deepEqual(await source.resolveMyOrg(credential),{id:8,name:'Team',role:10})
  assert.deepEqual(seen,['https://tokensapi.ai/api/user/self','https://tokensapi.ai/api/org/'])
  // Display name falls back to the account name rather than becoming blank.
  const bare=createTokensApiOrganizations(env,async()=>response({id:5001,username:'owner',display_name:'  '}))
  assert.equal((await bare.resolveAccount(credential)).displayName,'owner')
})
test('a token that is wrong, in no organization or disabled is an answer, not an outage',async()=>{
  const credential={accessToken:'fixture-token',userId:5001}
  // TokensAPI answers a rejected console credential with 200 and success:false, not with 401.
  const rejected=createTokensApiOrganizations(env,async()=>Response.json({success:false,message:'无效的访问令牌'}))
  assert.equal(await rejected.resolveAccount(credential),null)
  assert.equal(await rejected.resolveMyOrg(credential),null)
  const signedOut=createTokensApiOrganizations(env,async()=>new Response('sensitive upstream body',{status:401}))
  assert.equal(await signedOut.resolveAccount(credential),null)
  assert.equal(await signedOut.resolveMyOrg(credential),null)
  // 403 from the membership endpoint is "not a member", which is simply no seat.
  assert.equal(await createTokensApiOrganizations(env,async()=>new Response('denied',{status:403})).resolveMyOrg(credential),null)
  assert.equal(await createTokensApiOrganizations(env,async()=>response({id:8,name:'Team',status:0,my_role:100})).resolveMyOrg(credential),null)
  // A half credential, or one that could smuggle a second header field, is refused before any
  // call is made: the id is as mandatory as the token, and neither may carry a header break.
  let calls=0
  const guarded=createTokensApiOrganizations(env,async()=>{calls++;return response({})})
  for(const value of [undefined,{},{accessToken:'fixture-token'},{userId:5001},
    {accessToken:'fixture-token',userId:0},{accessToken:'fixture-token',userId:'5001'},
    {accessToken:'',userId:5001},{accessToken:'a b',userId:5001},
    {accessToken:'a\nX-Real: 1',userId:5001},{accessToken:'x'.repeat(4097),userId:5001}]){
    assert.equal(await guarded.resolveAccount(value),null)
    assert.equal(await guarded.resolveMyOrg(value),null)
  }
  assert.equal(calls,0)
  // Everything else still fails closed: a missing role or an unreachable site is never a sign-in.
  for(const reply of [()=>response({id:8,name:'Team',status:1}),()=>new Response('offline',{status:503})]){
    await assert.rejects(()=>createTokensApiOrganizations(env,async()=>reply()).resolveMyOrg(credential))
  }
  await assert.rejects(()=>createTokensApiOrganizations(env,async()=>response({id:0,username:'owner'})).resolveAccount(credential))
})
test('the Key owner and the user search come back as id and display name only',async()=>{
  const source=createTokensApiOrganizations(env,async url=>url.endsWith('/api/current/organization')
    ?response({organization:{id:8,name:'Team',status:1},user:{id:102,username:'alice',display_name:'Alice',quota:9}})
    :response({items:[{id:102,username:'alice',display_name:'',org_id:0},{id:103,username:'bob',display_name:'Bob',role:1,org_id:8}],total:2}))
  assert.deepEqual(await source.resolveIdentity('sk-fixture'),{organization:{id:8,name:'Team'},user:{id:102,name:'Alice'}})
  assert.deepEqual(await source.searchUsers('a b',2),{items:[{id:102,name:'alice',username:'alice',organizationId:null},{id:103,name:'Bob',username:'bob',organizationId:8}],total:2})
  const legacy=createTokensApiOrganizations(env,async()=>response({organization:null}))
  assert.deepEqual(await legacy.resolveIdentity('sk-fixture'),{organization:null,user:null})
  const searched=[]
  await createTokensApiOrganizations(env,async(url,options)=>{searched.push([url,options.headers.Authorization]);return response({items:[],total:0})}).searchUsers('a b',2)
  await createTokensApiOrganizations(env,async(url,options)=>{searched.push([url,options.headers.Authorization]);return response({items:[],total:0})}).searchUsers('7',1,100)
  assert.deepEqual(searched,[['https://tokensapi.ai/api/manage/users/search?keyword=a%20b&p=2&page_size=20','Bearer fixture-management-token'],
    ['https://tokensapi.ai/api/manage/users/search?keyword=7&p=1&page_size=100','Bearer fixture-management-token']])
})
