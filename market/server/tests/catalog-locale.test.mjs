import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
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
function tgz(files) {
  const blocks = []
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body), header = Buffer.alloc(512)
    header.write(name, 0); header.write('0000644\0', 100); header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('ustar\0', 257); header.write('00', 263); header[156] = 48
    header.fill(' ', 148, 156)
    header.write(([...header].reduce((a, b) => a + b, 0)).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, data, Buffer.alloc(-data.length & 511))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
const privateEnv = {MARKET_PRIVATE_REGISTRY_ENABLED:'true',MARKET_PRIVATE_REGISTRY_URL:'https://registry.example',MARKET_PRIVATE_REGISTRY_TOKEN:'fixture-token'}
function privateRegistry(t, version, manifest, archive) {
  const requests = []
  t.mock.method(globalThis,'fetch',async url => {
    requests.push(String(url))
    if (String(url).endsWith('.tgz')) return new Response(archive)
    return Response.json({name:item.package,'dist-tags':{latest:version},versions:{[version]:{name:item.package,version,dist:{tarball:`https://registry.example/finance-${version}.tgz`},...manifest}}})
  })
  return requests
}
const localeExport = {exports:{'.':'./lib/index.js','./package.json':'./package.json','./locale/*.json':'./locale/*.json'}}
test('private packages follow dsh locale files and skip unrelated archive entries', async t => {
  const archive = tgz({
    'package/package.json':'{}',
    'package/lib/index.js':'x'.repeat(5000),
    'package/locale/en.json':JSON.stringify({meta:{title:'Connection Center',description:'Manage IM bots.'}}),
    'package/locale/zh.json':JSON.stringify({meta:{title:'连接中心',description:'统一管理 IM 机器人。'}}),
  })
  privateRegistry(t, '3.0.0', localeExport, archive)
  const entry = {...item, registry:'tokenscowork', version:'3.0.0'}
  const [en] = await localizeCatalog([entry], privateEnv, 'en-US')
  assert.equal(en.displayName,'Connection Center'); assert.equal(en.summary,'Manage IM bots.')
  const [zh] = await localizeCatalog([entry], privateEnv, 'zh-CN')
  assert.equal(zh.displayName,'连接中心'); assert.equal(zh.summary,'统一管理 IM 机器人。')
})
test('tokenscowork map wins per language and dsh locale fills the rest', async t => {
  const archive = tgz({'package/locale/en.json':JSON.stringify({meta:{title:'From dsh',description:'dsh summary'}})})
  privateRegistry(t, '3.1.0', {...localeExport, tokenscowork:{displayName:{'en-US':'From map','zh-CN':'映射'}}}, archive)
  const [en] = await localizeCatalog([{...item, registry:'tokenscowork', version:'3.1.0'}], privateEnv, 'en-US')
  assert.equal(en.displayName,'From map'); assert.equal(en.summary,'dsh summary')
})
test('packages without the locale export or with broken locale files keep registered text', async t => {
  let requests = privateRegistry(t, '3.2.0', {}, tgz({'package/locale/en.json':JSON.stringify({meta:{title:'Unexported'}})}))
  assert.deepEqual(await localizeCatalog([{...item, registry:'tokenscowork', version:'3.2.0'}], privateEnv, 'en-US'), [{...item, registry:'tokenscowork', version:'3.2.0'}])
  assert.ok(!requests.some(url => url.endsWith('.tgz')))
  t.mock.restoreAll()
  for (const [version, archive] of [['3.3.0', tgz({'package/locale/en.json':'{not json'})], ['3.4.0', Buffer.from('not gzip')]]) {
    privateRegistry(t, version, localeExport, archive)
    const entry = {...item, registry:'tokenscowork', version}
    assert.deepEqual(await localizeCatalog([entry], privateEnv, 'en-US'), [entry])
    t.mock.restoreAll()
  }
})
test('public npm entries never download tarballs', async t => {
  const requests = []
  t.mock.method(globalThis,'fetch',async url => { requests.push(String(url)); return Response.json({name:item.package,version:'4.0.0',...localeExport,dist:{tarball:'https://registry.npmjs.org/x/-/x-4.0.0.tgz'}}) })
  await localizeCatalog([{...item, version:'4.0.0'}], {}, 'en-US')
  assert.deepEqual(requests.length, 1)
})
