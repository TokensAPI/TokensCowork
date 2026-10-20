import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import type { CatalogSnapshot } from '../src/contracts/index.js'
import { MarketInstallService, createMarketPackageVerifier, type MarketPluginManager } from '../src/install/service.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const idleManager = { listBundles: vi.fn(async () => []), listPlugins: vi.fn(async () => []),
  installBundle: vi.fn(), setBundleEnabled: vi.fn(), removeBundle: vi.fn() } as unknown as MarketPluginManager

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

/**
 * The per-operation pnpm configuration: only the product scope goes to the
 * private Registry, so a third-party dependency of a private plugin still
 * resolves through the registry the official manager asks.
 */
it.each(['', 'sk-fixture'])('scopes the private Registry without redirecting third-party dependencies (%s)', async key => {
  const dir = await mkdtemp(join(tmpdir(), 'market-registry-'))
  temporary.push(dir)
  const service = new MarketInstallService(() => ({ name: 'test', dir }), idleManager, { verify: vi.fn() },
    { registryOrigin: 'https://market.example', registryToken: async () => key })
  const lines = await (service as unknown as { productNpmrcLines(): Promise<string[]> }).productNpmrcLines()
  expect(lines).toContain('@tokensapi:registry=https://market.example/registry/by-package/')
  expect(lines.filter(line => line.includes('registry=') && !line.startsWith('@'))).toEqual([])
  expect(lines.filter(line => line.includes('_authToken')))
    .toEqual(key ? ['//market.example/registry/:_authToken=' + key] : [])
})

it('writes the product configuration for one operation only, and refuses a profile npmrc of the user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-registry-'))
  temporary.push(dir)
  const npmrc = join(dir, '.npmrc')
  const service = new MarketInstallService(() => ({ name: 'test', dir }), idleManager, { verify: vi.fn() },
    { registryOrigin: 'https://market.example', registryToken: async () => 'sk-fixture' })
  const run = (operation: () => Promise<unknown>) =>
    (service as unknown as { withProductNpmrc(task: () => Promise<unknown>): Promise<unknown> }).withProductNpmrc(operation)
  let seen = ''
  await run(async () => { seen = await readFile(npmrc, 'utf8') })
  expect(seen).toMatch(/_authToken=sk-fixture/u)
  expect(existsSync(npmrc)).toBe(false)
  await expect(run(async () => { throw new Error('pnpm failed') })).rejects.toThrow('pnpm failed')
  expect(existsSync(npmrc)).toBe(false)
  const mine = 'registry=https://my-mirror.example/\n'
  await writeFile(npmrc, mine)
  let ran = false
  await expect(run(async () => { ran = true })).rejects.toMatchObject({ code: 'conflict' })
  expect(ran).toBe(false)
  expect(await readFile(npmrc, 'utf8')).toBe(mine)
})

it.each(['npm', 'tokenscowork'] as const)('includes %s packages in the actual installable page', registry => {
  const service = new MarketInstallService(
    () => ({ name: 'desktop', dir: '.' }),
    idleManager,
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
