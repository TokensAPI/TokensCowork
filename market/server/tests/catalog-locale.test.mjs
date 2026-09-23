import test from 'node:test'
import assert from 'node:assert/strict'
import { localized, localizeCatalog } from '../services/catalog-locale-service.js'

test('locale selection is case insensitive, regional and malformed-safe', () => {
  const names = {'en-US':'Finance','zh-CN':'财务'}
  assert.equal(localized('old', names, 'en'), 'Finance')
  assert.equal(localized('old', names, 'EN-us'), 'Finance')
  assert.equal(localized('old', names, 'zh-CN'), '财务')
  assert.equal(localized('old', names, 'fr'), '财务')
  for (const bad of [[], null, {'en-US':{}}, {'en-US':123}, {'en-US':'\u0000'}, {'en-US':'x'.repeat(1001)}]) assert.equal(localized('old', bad, 'en-US'), 'old')
})
const item = {id:'finance', package:'@test/finance', version:'1.0.0', npm:true, displayName:'Old', summary:'Old summary'}
test('public metadata follows exact versions and caches text independently of locale', async t => {
  let calls=0
  t.mock.method(globalThis, 'fetch', async url => {
    calls++
    const version=String(url).split('/').pop()
    return Response.json({name:item.package, version, tokenscowork:{displayName:{'en-US':'Finance '+version,'zh-CN':'财务'}}})
  })
  const env={}
  const en=(await localizeCatalog([item],env,'en-US'))[0]
  assert.equal(en.displayName,'Finance 1.0.0'); assert.equal(en.summary,item.summary)
  assert.equal((await localizeCatalog([item],env,'zh-CN'))[0].displayName,'财务')
  assert.equal(calls,1)
  assert.equal((await localizeCatalog([{...item,version:'2.0.0'}],env,'en-US'))[0].displayName,'Finance 2.0.0')
  assert.equal(en.package,item.package);assert.equal(en.id,item.id);assert.equal(item.displayName,'Old')
})
test('missing metadata and registry errors preserve old entries and download identity', async t => {
  for (const response of [{name:item.package,version:item.version}, null]) {
    t.mock.method(globalThis,'fetch',async()=>{if(!response) throw Error('offline');return Response.json(response)})
    assert.deepEqual(await localizeCatalog([item],{},'en-US'),[item])
  }
})
test('private registry reads localized manifest without exposing credentials', async t => {
  t.mock.method(globalThis,'fetch',async()=>Response.json({name:item.package,'dist-tags':{latest:item.version},versions:{[item.version]:{name:item.package,version:item.version,dist:{tarball:'https://registry.example/test.tgz'},tokenscowork:{displayName:{en:'Private Finance'}}}}}))
  const env={MARKET_PRIVATE_REGISTRY_ENABLED:'true',MARKET_PRIVATE_REGISTRY_URL:'https://registry.example',MARKET_PRIVATE_REGISTRY_TOKEN:'fixture-token'}
  const result=await localizeCatalog([{...item,registry:'tokenscowork'}],env,'en-US')
  assert.equal(result[0].displayName,'Private Finance')
  assert.ok(!JSON.stringify(result).includes('fixture-token'))
})
