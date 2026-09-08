import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { addMarketAuth } from './market-auth.mjs'

const base = new URL('../../../../desktop/dsh-community-market/src/', import.meta.url)
const sources = Object.fromEntries(Object.entries({http:'network/restricted-http.ts',routes:'host/routes.ts',index:'index.ts'})
  .map(([k,p]) => [k,readFileSync(new URL(p,base),'utf8').replaceAll('\r\n','\n')]))
const origin = 'https://tokenscowork-market.pages.dev'
const output = addMarketAuth(sources, origin)
const compiled = stripTypeScriptTypes(output.http, {mode:'transform',disableExperimentalWarning:true})
const {createProductMarketAuthorization,createRestrictedHttpClient} = await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'))

test('only product catalog receives current Key, never third-party or unrelated paths', async () => {
  let key='sk-first', reads=0
  const auth=createProductMarketAuthorization(async()=>{reads++;return key})
  assert.equal(await auth(new URL(origin+'/v1/plugins')),'Bearer sk-first')
  key='sk-second'
  assert.equal(await auth(new URL(origin+'/roster.json')),'Bearer sk-second')
  for(const url of ['https://registry.npmjs.org/v1/plugins','https://github.com/v1/plugins',origin+'.evil.test/v1/plugins',origin+'/api/admin/access','http://tokenscowork-market.pages.dev/v1/plugins']) assert.equal(await auth(new URL(url)),undefined)
  assert.equal(reads,2)
  for(const value of ['', 'sk-test\r\nInjected: yes']) {key=value;assert.equal(await auth(new URL(origin+'/v1/plugins')),undefined)}
})

test('real HTTP request construction sends header and strips it on foreign redirect', async t => {
  const original=https.request, observed=[]
  t.after(()=>{https.request=original})
  https.request=(url, options, callback)=>{
    observed.push({url:url.href,headers:options.headers})
    const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
      const res=new EventEmitter();res.statusCode=observed.length===1?302:200
      res.headers=observed.length===1?{location:'https://example.com/v1/plugins'}:{'content-type':'application/json'}
      callback(res);res.emit('data',Buffer.from('{}'));res.emit('end')
    });return req
  }
  const client=createRestrictedHttpClient({resolveAddress:async()=>({address:'8.8.8.8',family:4}),authorization:createProductMarketAuthorization(async()=> 'sk-fixture')})
  await client.getJson(origin+'/v1/plugins',new AbortController().signal)
  assert.equal(observed[0].headers.authorization,'Bearer sk-fixture')
  assert.equal(observed[1].headers.authorization,undefined)
  assert.ok(!observed[0].url.includes('sk-fixture'))
})

test('overlay fails on source drift and avoids unscoped persisted catalogs',()=>{
  assert.throws(()=>addMarketAuth({...sources,http:''},origin),/anchor changed/)
  assert.match(output.routes,/service.invalidateSource/)
  assert.match(output.routes,/cachedCatalogResponse\(undefined,/)
  assert.doesNotMatch(output.routes,/scope.update\(\{ catalogCache: cache \}\)/)
  assert.match(output.index,/optional: \['credentials'\]/)
})
