import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { addMarketAuth } from './market-auth-overlay.mjs'
import { addMarketHome } from './market-home-overlay.mjs'
import {
  CATALOG_REQUEST_BUDGET_MS,
  SOURCE_MANIFEST_TTL_MS,
  allowStaleCatalogOnDiscover,
  cacheStandardSourceManifests,
  expectStaleScanOptionInRuntimeTest,
  failFastOnCatalogRequests,
  keepStaleCatalogOnRefreshFailure,
  reportStaleCatalogMetadata,
  serveStaleCatalogScans,
} from './market-discover-latency-overlay.mjs'
import { allowMarketSourceSyntheticProxy } from './market-source-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const upstream = path =>
  readFileSync(resolve(root, 'desktop/dsh-community-market', path), 'utf8').replaceAll('\r\n', '\n')
const origin = JSON.parse(readFileSync(resolve(root, 'market/server/source.config.json'), 'utf8')).origin

/**
 * 快速失败覆盖排在 market.synthetic-proxy 与 market.auth 之后：它要插的那行
 * 产品选项就在它们改写出来的那个单例里，所以按装配顺序叠两层再测。
 */
function productHttp() {
  const hostname = new URL(origin).hostname
  return addMarketAuth({
    http: allowMarketSourceSyntheticProxy(upstream('src/network/restricted-http.ts'), hostname),
    routes: upstream('src/host/routes.ts'),
    index: upstream('src/index.ts'),
  }, origin).http
}

/** 客户端覆盖排在 market.discover-home 之后：两处锚点是它切出发现页时的产物。 */
function discoverClient() {
  return addMarketHome({
    settingsTab: upstream('src/client/MarketSettingsTab.tsx'),
    locales: upstream('src/client/locales.ts'),
  })
}

test('only the product catalog client gives up early; the other clients keep the upstream budget', () => {
  const http = failFastOnCatalogRequests(productHttp())
  assert.equal(CATALOG_REQUEST_BUDGET_MS, 8_000)
  assert.match(http, new RegExp(`const PRODUCT_CATALOG_REQUEST_BUDGET_MS = ${CATALOG_REQUEST_BUDGET_MS}`, 'u'))
  // 上游默认仍在原位：其他客户端（1024Store、dshfind、npm Registry）照旧。
  assert.match(http, /const TOTAL_TIMEOUT_MS = 30_000/u)
  const singleton = http.slice(http.indexOf('export const restrictedHttpClient'))
  assert.match(singleton, /totalTimeoutMs: PRODUCT_CATALOG_REQUEST_BUDGET_MS,/u)
  assert.equal(http.split('totalTimeoutMs: PRODUCT_CATALOG_REQUEST_BUDGET_MS').length - 1, 1)
  assert.throws(() => failFastOnCatalogRequests(http), AnchorError)
})

test('the standard adapter reads a source manifest once instead of before every scan', () => {
  const { adapter, service, types } = cacheStandardSourceManifests({
    adapter: upstream('src/adapters/standard-http.ts'),
    service: upstream('src/catalog/service.ts'),
    types: upstream('src/contracts/types.ts'),
  }, origin)
  assert.match(adapter, new RegExp(`const SOURCE_MANIFEST_TTL_MS = ${SOURCE_MANIFEST_TTL_MS}`, 'u'))
  assert.equal(SOURCE_MANIFEST_TTL_MS, 24 * 60 * 60 * 1000)
  // 只认产品 origin：用户自添的标准源仍每次重读清单。
  assert.match(adapter, new RegExp(`const PRODUCT_MANIFEST_ORIGIN = ${JSON.stringify(origin)}`, 'u'))
  assert.match(adapter, /if \(registeredOrigin === PRODUCT_MANIFEST_ORIGIN && context\.force !== true\) \{/u)
  assert.match(adapter, /if \(registeredOrigin === PRODUCT_MANIFEST_ORIGIN\) sourceManifests\.set\(/u)
  // 清单读取只剩一条路径，而且两条不变量在那条路径上都还在。
  assert.equal(adapter.split('await resolveSourceManifest(').length - 1, 1)
  assert.doesNotMatch(adapter, /const manifestResponse = await context\.http\.getJson\(/u)
  assert.match(adapter, /manifest\.providerId !== source\.providerId/u)
  assert.match(adapter, /requireOrigin\(manifest\.transport\.endpoint, registeredOrigin/u)
  assert.match(adapter, /assertStandardSourceTrustRoot\(manifestUrl, response\.finalUrl/u)
  // 固定清单只在没缓存且没要求强制刷新时作为起点。
  assert.match(adapter, /if \(cached === undefined && pinned !== undefined\) \{/u)
  assert.match(types, /readonly force\?: boolean/u)
  assert.match(service, /forgetStandardSourceManifest\(sourceRecordId\)/u)
  assert.equal(service.split('force: options.force === true').length - 1, 2)
  assert.throws(() => cacheStandardSourceManifests({ adapter, service, types }, origin), AnchorError)
  assert.throws(() => cacheStandardSourceManifests({ adapter, service, types }, 'http://market.example'), AnchorError)
})

test('an expired scan is served before the scan lock and kept until a newer one lands', () => {
  const service = serveStaleCatalogScans(upstream('src/catalog/service.ts'))
  assert.match(service, /readonly allowStale\?: boolean/u)
  assert.match(service, /return cachedScanView\(cached, 'stale'\)/u)
  assert.match(service, /cacheStatus: 'fresh' \| 'cached' \| 'stale'/u)
  // 扫描期间（以及扫描失败后）快照还在：强制刷新、进锁前、锁内三处丢弃都已拿掉。
  assert.doesNotMatch(service, /this\.catalogScanGenerations\.set\(key, generation\)\n {4}this\.catalogScanCache\.delete\(key\)/u)
  assert.doesNotMatch(service, /cached\.expiresAt\) this\.revokeSourceCursors\(source\.sourceRecordId\)\n {6}this\.catalogScanCache\.delete\(key\)/u)
  assert.doesNotMatch(service, /cachedAfterWait\.expiresAt\) this\.revokeSourceCursors\(source\.sourceRecordId\)\n {8}this\.catalogScanCache\.delete\(key\)/u)
  // 过期仍然撤销游标。
  assert.match(service, /if \(cachedAfterWait !== undefined && this\.now\(\) >= cachedAfterWait\.expiresAt\) \{\n {8}this\.revokeSourceCursors\(source\.sourceRecordId\)/u)
  assert.match(service, /if \(this\.now\(\) >= cached\.expiresAt\) this\.revokeSourceCursors\(source\.sourceRecordId\)/u)
  // 查询结果照实标 stale。
  assert.match(service, /const stale = index\.cacheStatus === 'stale'/u)
  assert.doesNotMatch(service, /stale: false,\n {4}\}\]/u)
  assert.throws(() => serveStaleCatalogScans(service), AnchorError)
})

test('a plain Discover open takes the stale snapshot; a refresh still waits for the provider', () => {
  const routes = allowStaleCatalogOnDiscover(upstream('src/host/routes.ts'))
  assert.match(routes, /index = await service\.scanCatalog\(signal, \{\n(?: {12}\/\/[^\n]*\n)+ {12}allowStale: !force,\n {12}force,/u)
  // 另一条扫描调用（installable）不受影响。
  assert.equal(routes.split('allowStale').length - 1, 1)
  assert.match(reportStaleCatalogMetadata(upstream('src/api-types.ts')),
    /readonly cacheStatus: 'fresh' \| 'cached' \| 'stale'/u)
  assert.throws(() => allowStaleCatalogOnDiscover(routes), AnchorError)
  // 上游那条逐字断言选项的用例跟着补上 allowStale，其余断言不动。
  const tests = expectStaleScanOptionInRuntimeTest(upstream('tests/market-runtime.spec.ts'))
  assert.match(tests, /toHaveBeenCalledWith\(expect\.any\(AbortSignal\), \{ allowStale: true, force: false \}\)/u)
  assert.match(tests, /\{ category: \['dev', 'tools'\], limit: 50 \},\n {8}undefined,/u)
  assert.throws(() => expectStaleScanOptionInRuntimeTest(tests), AnchorError)
})

test('a failed background refresh keeps the catalog on screen and offers a retry', () => {
  const { settingsTab, locales } = keepStaleCatalogOnRefreshFailure(discoverClient())
  assert.match(settingsTab, /const \[refreshError, setRefreshError\] = useState<string>\(\)/u)
  // 刷新失败只设自己的提示，不覆盖已经渲染出来的目录。
  assert.match(settingsTab, /\} catch \{\n {12}if \(!request\.signal\.aborted && readRequest\.current === request\) \{\n {14}setRefreshError\(t\('catalogRefreshFailed'\)\)/u)
  assert.match(settingsTab, /setError\(undefined\)\n {4}setRefreshError\(undefined\)/u)
  assert.match(settingsTab, /props\.refreshError !== undefined && <div className="dshMarketBanner" role="alert">/u)
  assert.match(settingsTab, /onClick=\{props\.onRetryRefresh\}/u)
  assert.match(settingsTab, /void loadCatalog\(state, appliedQuery, selectedCategories, true\)/u)
  assert.match(locales, /catalogRefreshFailed: "显示的是上次的插件目录，刷新失败。"/u)
  assert.match(locales, /catalogRefreshFailed: "Showing the last known plugin catalog; the refresh failed\."/u)
  assert.throws(() => keepStaleCatalogOnRefreshFailure({ settingsTab, locales }), AnchorError)
})

test('every overlay refuses an upstream that no longer matches', () => {
  for (const [label, apply] of [
    ['fast fail', () => failFastOnCatalogRequests(upstream('src/network/restricted-http.ts'))],
    ['stale first', () => serveStaleCatalogScans(upstream('src/host/routes.ts'))],
    ['discover route', () => allowStaleCatalogOnDiscover(upstream('src/catalog/service.ts'))],
    ['client retry', () => keepStaleCatalogOnRefreshFailure({
      settingsTab: upstream('src/client/MarketSettingsTab.tsx'),
      locales: upstream('src/client/locales.ts'),
    })],
  ]) assert.throws(apply, AnchorError, label)
})
