import dns from 'node:dns'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetStandardSourceManifest, standardHttpAdapter } from '../src/adapters/standard-http.js'
import { DefaultCatalogService } from '../src/catalog/service.js'
import type { CatalogSourceManifest } from '../src/contracts/generated/catalog-source.js'
import type {
  CatalogHttpClient,
  CatalogMediaRegistry,
  LocalSourceRecord,
} from '../src/contracts/types.js'
import { PRODUCT_SOURCE } from '../src/host/routes.js'
import { CatalogNetworkError, restrictedHttpClient } from '../src/network/restricted-http.js'

/**
 * Product regressions for the Discover first-paint work (T0042): an expired
 * scan is served before the scan lock is taken, a hung remote request fails
 * inside the product budget and frees the lock, and the product source's
 * manifest is read once instead of before every scan.
 */

const providerPage = JSON.parse(readFileSync(
  new URL('../docs/examples/catalog-provider-page.minimal.example.json', import.meta.url),
  'utf8',
)) as unknown

const pinnedManifest = PRODUCT_SOURCE.manifest as CatalogSourceManifest
const MANIFEST_URL = PRODUCT_SOURCE.manifestUrl as string
const PRODUCT_ORIGIN = new URL(MANIFEST_URL).origin
const signal = () => new AbortController().signal

const media: CatalogMediaRegistry = {
  register: () => { throw new Error('the fixture catalog page carries no media') },
  unregisterSource: () => {},
}

const source = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord =>
  ({ ...PRODUCT_SOURCE, ...overrides })

/** Records every URL the catalog layer asks for, so hops are countable. */
function recordingHttp(overrides: {
  readonly onCatalog?: () => Promise<unknown>
} = {}): { readonly client: CatalogHttpClient; readonly urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    client: {
      getJson: async url => {
        urls.push(url)
        if (url === MANIFEST_URL) return { value: structuredClone(pinnedManifest), finalUrl: url }
        const value = await (overrides.onCatalog?.() ?? Promise.resolve(structuredClone(providerPage)))
        return { value, finalUrl: url }
      },
    },
  }
}

const manifestHops = (urls: readonly string[]): number => urls.filter(url => url === MANIFEST_URL).length
const catalogHops = (urls: readonly string[]): number => urls.filter(url => url !== MANIFEST_URL).length

function service(http: CatalogHttpClient, now: () => number, catalogScanCacheTtlMs = 5 * 60 * 1000) {
  const record = source()
  return new DefaultCatalogService({ load: async () => [record] }, http, {
    now,
    catalogScanCacheTtlMs,
    media,
  })
}

const adapterContext = (http: CatalogHttpClient, overrides: Partial<LocalSourceRecord> = {}) => ({
  signal: signal(),
  source: source(overrides),
  http,
  media,
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  forgetStandardSourceManifest(PRODUCT_SOURCE.sourceRecordId)
})

describe('Discover serves the last known catalog before the scan lock', () => {
  it('returns an expired scan as stale without touching the provider', async () => {
    const http = recordingHttp()
    let clock = 1_000
    const catalog = service(http.client, () => clock)

    const fresh = await catalog.scanCatalog(signal(), { allowStale: true })
    expect(fresh?.cacheStatus).toBe('fresh')
    expect(catalogHops(http.urls)).toBe(1)

    // Still inside the TTL: upstream's own cache hit, not the stale path.
    expect((await catalog.scanCatalog(signal(), { allowStale: true }))?.cacheStatus).toBe('cached')

    clock += 10 * 60 * 1000
    const stale = await catalog.scanCatalog(signal(), { allowStale: true })
    expect(stale?.cacheStatus).toBe('stale')
    expect(catalogHops(http.urls)).toBe(1)
    expect(stale?.snapshots.flatMap(snapshot => snapshot.items)).toHaveLength(1)
    expect(catalog.queryCatalog(stale!, {})[0]?.stale).toBe(true)

    const refreshed = await catalog.scanCatalog(signal(), { force: true })
    expect(refreshed?.cacheStatus).toBe('fresh')
    expect(catalog.queryCatalog(refreshed!, {})[0]?.stale).toBe(false)
  })

  it('answers while a hung refresh still holds the scan lock', async () => {
    let releaseHungRefresh: (() => void) | undefined
    let hang = false
    const http = recordingHttp({
      onCatalog: async () => {
        if (hang) await new Promise<void>(resolve => { releaseHungRefresh = resolve })
        return structuredClone(providerPage)
      },
    })
    let clock = 1_000
    const catalog = service(http.client, () => clock)
    await catalog.scanCatalog(signal(), { allowStale: true })
    clock += 10 * 60 * 1000

    hang = true
    const refresh = catalog.scanCatalog(signal(), { force: true })
    // The forced refresh holds the per-source scan gate from here on.
    await vi.waitFor(() => { expect(releaseHungRefresh).toBeTypeOf('function') })

    const stale = await catalog.scanCatalog(signal(), { allowStale: true })
    expect(stale?.cacheStatus).toBe('stale')
    expect(catalog.queryCatalog(stale!, {})[0]?.snapshot?.items).toHaveLength(1)

    releaseHungRefresh?.()
    expect((await refresh)?.cacheStatus).toBe('fresh')
  })

  it('frees the scan lock when the remote request fails, so the next open proceeds', async () => {
    let failFirstScan: ((cause: unknown) => void) | undefined
    let pending = true
    const http = recordingHttp({
      onCatalog: async () => {
        if (!pending) return structuredClone(providerPage)
        pending = false
        return await new Promise((_resolve, reject) => { failFirstScan = reject })
      },
    })
    const catalog = service(http.client, () => 1_000)

    const blocked = catalog.scanCatalog(signal())
    await vi.waitFor(() => { expect(failFirstScan).toBeTypeOf('function') })
    const queued = catalog.scanCatalog(signal())

    failFirstScan?.(new CatalogNetworkError('timeout'))
    await expect(blocked).rejects.toMatchObject({ name: 'CatalogNetworkError', code: 'timeout' })
    expect((await queued)?.cacheStatus).toBe('fresh')
  })
})

describe('the product catalog client gives up on a hung request', () => {
  it('fails inside the product budget rather than the upstream one', async () => {
    vi.useFakeTimers()
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
    // A request object that connects and then says nothing: the only thing
    // that can end this call is the client's own total budget.
    vi.spyOn(https, 'request').mockImplementation(() => Object.assign(new EventEmitter(), {
      end: () => {},
      destroy: () => {},
    }) as never)

    const request = restrictedHttpClient.getJson(`${PRODUCT_ORIGIN}/v1/plugins`, signal())
    const settled = vi.fn()
    void request.then(settled, settled)

    await vi.advanceTimersByTimeAsync(7_000)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(request).rejects.toMatchObject({ name: 'CatalogNetworkError', code: 'timeout' })
  })
})

describe('the product source manifest is read once instead of before every scan', () => {
  it('starts from the manifest pinned in the source record', async () => {
    const http = recordingHttp()
    let clock = 1_000
    const catalog = service(http.client, () => clock)

    await catalog.scanCatalog(signal(), { allowStale: true })
    expect(manifestHops(http.urls)).toBe(0)
    expect(catalogHops(http.urls)).toBe(1)

    clock += 10 * 60 * 1000
    await catalog.scanCatalog(signal())
    expect(manifestHops(http.urls)).toBe(0)
    expect(catalogHops(http.urls)).toBe(2)
  })

  it('re-reads the manifest for a user-requested refresh and caches it again', async () => {
    const http = recordingHttp()
    await standardHttpAdapter.fetch({ limit: 50 }, { ...adapterContext(http.client), force: true })
    expect(manifestHops(http.urls)).toBe(1)

    await standardHttpAdapter.fetch({ limit: 50 }, adapterContext(http.client))
    expect(manifestHops(http.urls)).toBe(1)
  })

  it('re-reads the manifest once its lifetime has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
    const http = recordingHttp()

    await standardHttpAdapter.fetch({ limit: 50 }, adapterContext(http.client))
    expect(manifestHops(http.urls)).toBe(0)

    vi.setSystemTime(new Date('2026-10-22T00:00:01.000Z'))
    await standardHttpAdapter.fetch({ limit: 50 }, adapterContext(http.client))
    expect(manifestHops(http.urls)).toBe(1)
  })

  it('refuses a pinned manifest that points its query endpoint elsewhere', async () => {
    const http = recordingHttp()
    const moved = {
      ...pinnedManifest,
      transport: { ...pinnedManifest.transport, endpoint: 'https://plugins.example.net/v1/plugins' },
    }
    await expect(standardHttpAdapter.fetch({ limit: 50 }, adapterContext(http.client, { manifest: moved })))
      .rejects.toThrow(/registered source origin/u)
    expect(http.urls).toHaveLength(0)
  })

  it('refuses a pinned manifest that claims another provider', async () => {
    const http = recordingHttp()
    const renamed = { ...pinnedManifest, providerId: 'org.example.other' }
    await expect(standardHttpAdapter.fetch({ limit: 50 }, adapterContext(http.client, { manifest: renamed })))
      .rejects.toThrow(/provider identity changed/u)
    expect(http.urls).toHaveLength(0)
  })

  it('keeps every request on the registered product origin', async () => {
    const http = recordingHttp()
    await standardHttpAdapter.fetch({ limit: 50 }, adapterContext(http.client))
    expect(http.urls).not.toHaveLength(0)
    expect(http.urls.every(url => new URL(url).origin === PRODUCT_ORIGIN)).toBe(true)
  })

  it('leaves a user-added standard source on the upstream contract', async () => {
    const http = recordingHttp()
    const foreign = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      manifestUrl: 'https://plugins.example.org/catalog-source.json',
    })
    // The manifest for a source the product does not host is still read first,
    // so a drifted one is caught on the spot rather than up to a day later.
    await expect(standardHttpAdapter.fetch({ limit: 50 }, { ...adapterContext(http.client), source: foreign }))
      .rejects.toThrow()
    expect(http.urls).toEqual(['https://plugins.example.org/catalog-source.json'])
  })
})
