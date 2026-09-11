import { expect, it, vi } from 'vitest'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import type { CatalogSnapshot } from '../src/contracts/index.js'
import { MarketInstallService, createMarketPackageVerifier, type MarketDesktopPnpm } from '../src/install/service.js'

it('preserves self-hosted identity through the real composite verifier', async () => {
  const name='@tokensapi/dsh-plugin-check', origin='https://market.example'
  const getJson=vi.fn(async (url: string) => {
    expect(url).toBe(origin+'/registry/plugin-check/'+encodeURIComponent(name))
    return {finalUrl:url,value:{name,'dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name,version:'1.0.0',dsh:{bundle:{patch:'./cordis.patch.yml'}}}}}}
  })
  const verifier=createMarketPackageVerifier({getJson},{privateRegistryOrigin:origin})
  await expect(verifier.verify({packageName:name,packageRegistry:'tokenscowork',itemId:'plugin-check'},new AbortController().signal)).resolves.toMatchObject({version:'1.0.0'})
  expect(getJson).toHaveBeenCalledTimes(1)
})

it.each(['', 'sk-fixture'])('builds scoped install options without redirecting third-party dependencies (%s)', async key => {
  const service=new MarketInstallService(()=>({name:'test',dir:'.'}),{} as MarketDesktopPnpm,{verify:vi.fn()},
    {registryOrigin:'https://market.example',registryToken:async()=>key})
  const options=await (service as unknown as {installOptions(c:object):Promise<string[]>}).installOptions({packageName:'@tokensapi/tool',packageRegistry:'tokenscowork',itemId:'tool'})
  expect(options).toContain('--registry=https://registry.npmjs.org/')
  expect(options).toContain('--@tokensapi:registry=https://market.example/registry/tool/')
  expect(options.filter(x=>x.includes('_authToken'))).toEqual(key?['--//market.example/registry/tool/:_authToken='+key]:[])
})

it.each(['npm', 'tokenscowork'] as const)('includes %s packages in the actual installable page', registry => {
  const service = new MarketInstallService(
    () => ({ name: 'desktop', dir: '.' }),
    {} as MarketDesktopPnpm,
    { verify: vi.fn() },
  )
  const sourceRecordId = 'source-1', providerId = DSH_1024STORE_PROVIDER_ID
  const snapshot: CatalogSnapshot = {
    schemaVersion: '1.0.0',
    source: {sourceRecordId, providerId, adapterId: DSH_1024STORE_ADAPTER_ID,
      registrationKind: 'built-in', fetchedAt: '2026-09-11T00:00:00.000Z',
      finalUrl: 'https://deepseek1024.com/api/v2/plugins'},
    items: [{id:'fixture', name:'@tokensapi/dsh-browser-use', displayName:'Browser', summary:'Fixture',
      package:{registry, name:'@tokensapi/dsh-browser-use'},
      provenance:{sourceRecordId,providerId,itemId:'fixture'}}],
    page: {},
  }
  const result = service.listInstallablePage({sourceRecordId,providerId,
    adapterId:DSH_1024STORE_ADAPTER_ID,registrationKind:'built-in',enabled:true,order:0,
    name:'Fixture',endpoint:'https://deepseek1024.com/api/v2/plugins',partnership:true},
    snapshot, [], new AbortController().signal)
  expect(result.items.map(item => item.id)).toEqual(['fixture'])
})
