import { expect, it, vi } from 'vitest'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import type { CatalogSnapshot } from '../src/contracts/index.js'
import { MarketInstallService, type MarketDesktopPnpm } from '../src/install/service.js'

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
