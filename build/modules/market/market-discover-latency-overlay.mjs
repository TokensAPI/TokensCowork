/* ====================================================================
 * 「发现」页的首屏延迟与挂起
 * 真机上打开侧栏「插件市场」→「发现」会转几十秒再突然好。链路本身不慢
 * （服务器 TTFB 约 0.3 s），慢的是本地代理：每条新 HTTPS 连接要付约
 * 0.8 s 握手，偶发还会挂住十几秒。目录扫描按来源串行（service.ts 的
 * scanGate），一条挂住的连接会把后续每次打开都排在它后面，直到那条请求
 * 自己超时（上游总预算 30 s）才一起放行——这就是"转几十秒后突然好"。
 *
 * 本覆盖做三件事，三件都只收窄等待，不改上游的信任根与校验：
 *  1. 有快照先显示：过期但来源未变的扫描结果立即按 `stale` 返回，不进
 *     扫描锁；界面先渲染旧目录，刷新在后台走，失败保留旧内容并给出重试。
 *  2. 远程请求快速失败：产品目录源那个受限 HTTP 客户端的总预算收到 8 s，
 *     挂起的连接最多占住扫描锁 8 s。
 *  3. 清单按来源缓存：`source.json` 只带提供方身份与查询端点，随产品发版
 *     才变，却要在每次扫描前多付一次握手。改为按来源缓存 24 h，并用来源
 *     记录里那份已校验的固定清单作为起点，首次扫描从两跳降到一跳。
 *
 * 连接复用不在本覆盖内：市场走 node:https（pinned lookup），代理由宿主的
 * @deepseek-ai/dsh-http-proxy 接管，属于平台侧。
 *
 * 必须排在 market.auth（改写受限客户端单例）与 market.discover-home
 * （切出 DiscoverView 并插入清单错误条）之后：两处锚点就是它们的产物。
 * ==================================================================== */
import { AnchorError, insertAfter, replaceOnce } from '../../pipeline/anchors.mjs'

/**
 * 产品目录源单次远程请求的总预算。
 * 代理下一次请求约 1.1 s（含 0.8 s 握手），实测目录页 535 字节；8 s 给
 * 偶发慢握手留足余量，又让挂住的连接不会把扫描锁占到上游那 30 s。
 */
export const CATALOG_REQUEST_BUDGET_MS = 8_000

/** 清单按来源缓存的时长：清单随产品发版才变。 */
export const SOURCE_MANIFEST_TTL_MS = 24 * 60 * 60 * 1000

/** 2) 产品目录源的受限 HTTP 客户端：总预算收窄到 8 s。 */
export function failFastOnCatalogRequests(http) {
  http = replaceOnce(http, `const TOTAL_TIMEOUT_MS = 30_000

export class CatalogNetworkError extends Error {`,
    `const TOTAL_TIMEOUT_MS = 30_000
/**
 * Product policy: the budget for one catalog request made against the pinned
 * product source. A proxied request costs about 1.1 s including its TLS
 * handshake and the catalog page is under a kilobyte, but a hung handshake can
 * sit for tens of seconds. Catalog scans are serialized per source, so that
 * one connection holds every later request behind it for as long as the budget
 * lasts; ${CATALOG_REQUEST_BUDGET_MS / 1000} seconds leaves room for a slow handshake and still releases the
 * scan lock while the user is still looking at the page. Other clients
 * (1024Store, dshfind, the npm Registry) keep the upstream default.
 */
const PRODUCT_CATALOG_REQUEST_BUDGET_MS = ${CATALOG_REQUEST_BUDGET_MS}

export class CatalogNetworkError extends Error {`,
    'catalog request budget')
  return replaceOnce(http, `  authorization: async (url) => productMarketAuthorizationHook?.(url),
})`, `  authorization: async (url) => productMarketAuthorizationHook?.(url),
  totalTimeoutMs: PRODUCT_CATALOG_REQUEST_BUDGET_MS,
})`, 'catalog request budget wiring')
}

/**
 * 3) 标准源适配器：产品来源的清单按来源缓存，并以来源记录里那份固定清单起步。
 * 只对产品来源生效：产品自己构建并托管这份 source.json，记录里那份就是发出去
 * 的那份；用户自添的标准源仍按上游语义每次重读，漂移照旧当场发现。
 */
export function cacheStandardSourceManifests({ adapter, service, types }, origin) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin) {
    throw new AnchorError(`market-discover-latency: 需要 HTTPS origin，实际 ${origin}`)
  }
  adapter = replaceOnce(adapter,
    "import type { CatalogProviderPage } from '../contracts/generated/catalog-provider-page.js'",
    `import type { CatalogProviderPage } from '../contracts/generated/catalog-provider-page.js'
import type { CatalogSourceManifest } from '../contracts/generated/catalog-source.js'`,
    'standard source manifest type')
  adapter = insertAfter(adapter, `export function assertStandardSourceTrustRoot(
  manifestUrlValue: string,
  manifestFinalUrl: string,
  endpointValue: string,
): string {
  const manifestUrl = safeHttpsUrl(manifestUrlValue, 'standard source manifest URL')
  requireOrigin(manifestFinalUrl, manifestUrl.origin, 'standard source manifest final URL')
  requireOrigin(endpointValue, manifestUrl.origin, 'standard source endpoint')
  return manifestUrl.origin
}`, `

/**
 * Product policy: how long the product source's manifest may be reused. It
 * carries only the provider's identity claim and its query transport, both of
 * which change with a product release, yet re-reading it before every catalog
 * scan costs a second TLS handshake on a proxied link — about a second, paid
 * before the catalog request even starts. Only this one origin is reused: the
 * product builds and hosts that manifest, and the copy pinned in the source
 * record is the copy being served. Any other standard source keeps the
 * upstream contract, where the provider's own manifest is re-read every scan
 * and a drifted one is caught on the spot.
 */
const PRODUCT_MANIFEST_ORIGIN = ${JSON.stringify(origin)}
const SOURCE_MANIFEST_TTL_MS = ${SOURCE_MANIFEST_TTL_MS}

interface CachedSourceManifest {
  readonly manifest: CatalogSourceManifest
  readonly savedAt: number
}

/** Reusable manifests, keyed by source record and registered manifest URL. */
const sourceManifests = new Map<string, CachedSourceManifest>()

/** Drop a source's manifest, so its next scan reads one from the provider. */
export function forgetStandardSourceManifest(sourceRecordId: string): void {
  for (const key of [...sourceManifests.keys()]) {
    if (key.startsWith(\`\${sourceRecordId}\\0\`)) sourceManifests.delete(key)
  }
}

/**
 * The two claims a manifest has to keep whichever way it arrived: it describes
 * the provider the record was registered against, and its query endpoint stays
 * inside the registered origin.
 */
function acceptSourceManifest(
  manifest: CatalogSourceManifest,
  source: CatalogFetchContext['source'],
  registeredOrigin: string,
): CatalogSourceManifest {
  if (manifest.providerId !== source.providerId) {
    throw new Error('standard source provider identity changed after registration')
  }
  requireOrigin(manifest.transport.endpoint, registeredOrigin, 'standard source endpoint')
  return manifest
}

async function resolveSourceManifest(
  context: CatalogFetchContext,
  manifestUrl: string,
  registeredOrigin: string,
): Promise<CatalogSourceManifest> {
  const key = \`\${context.source.sourceRecordId}\\0\${manifestUrl}\`
  const cached = sourceManifests.get(key)
  if (registeredOrigin === PRODUCT_MANIFEST_ORIGIN && context.force !== true) {
    if (cached !== undefined && Date.now() - cached.savedAt < SOURCE_MANIFEST_TTL_MS) return cached.manifest
    const pinned = context.source.manifest
    if (cached === undefined && pinned !== undefined) {
      // The registry validated this manifest against the record's provider
      // claim and registered origin before writing it, so reusing it reaches
      // the same trust root a fresh read would, without the handshake. Both
      // invariants are re-checked here rather than trusted from storage.
      const manifest = acceptSourceManifest(parseCatalogSource(pinned), context.source, registeredOrigin)
      sourceManifests.set(key, { manifest, savedAt: Date.now() })
      return manifest
    }
  }
  const response = await context.http.getJson(manifestUrl, context.signal, { allowedOrigin: registeredOrigin })
  const manifest = acceptSourceManifest(parseCatalogSource(response.value), context.source, registeredOrigin)
  assertStandardSourceTrustRoot(manifestUrl, response.finalUrl, manifest.transport.endpoint)
  if (registeredOrigin === PRODUCT_MANIFEST_ORIGIN) sourceManifests.set(key, { manifest, savedAt: Date.now() })
  return manifest
}`, 'standard source manifest cache')
  // assertStandardSourceTrustRoot 返回的就是 manifestUrl 的 origin，与这里算出的
  // registeredOrigin 同值；网络路径仍在 resolveSourceManifest 里完整校验一次。
  adapter = replaceOnce(adapter, `    if (context.source.manifestUrl === undefined) throw new Error('standard source has no manifest URL')
    const registeredOrigin = safeHttpsUrl(context.source.manifestUrl, 'standard source manifest URL').origin
    const manifestResponse = await context.http.getJson(
      context.source.manifestUrl,
      context.signal,
      { allowedOrigin: registeredOrigin },
    )
    const manifest = parseCatalogSource(manifestResponse.value)
    if (manifest.providerId !== context.source.providerId) {
      throw new Error('standard source provider identity changed after registration')
    }
    const sourceOrigin = assertStandardSourceTrustRoot(
      context.source.manifestUrl,
      manifestResponse.finalUrl,
      manifest.transport.endpoint,
    )`, `    const manifestUrl = context.source.manifestUrl
    if (manifestUrl === undefined) throw new Error('standard source has no manifest URL')
    const sourceOrigin = safeHttpsUrl(manifestUrl, 'standard source manifest URL').origin
    const manifest = await resolveSourceManifest(context, manifestUrl, sourceOrigin)`,
    'standard source manifest read')
  // 适配器要能看见"用户按了刷新"，才知道这次不能吃清单缓存。
  types = replaceOnce(types, `export interface CatalogFetchContext {
  readonly signal: AbortSignal`, `export interface CatalogFetchContext {
  /** Product overlay: a user-requested refresh bypasses product-side caches. */
  readonly force?: boolean
  readonly signal: AbortSignal`, 'catalog fetch refresh intent')
  service = replaceOnce(service, "import { standardHttpAdapter } from '../adapters/standard-http.js'",
    "import { forgetStandardSourceManifest, standardHttpAdapter } from '../adapters/standard-http.js'",
    'manifest cache import')
  // 来源被停用、改写或凭据切换时一并丢掉清单，下次扫描重新读一份。
  service = replaceOnce(service,
    `  invalidateSource(sourceRecordId: string): void {
    this.sourceGenerations.set(sourceRecordId, (this.sourceGenerations.get(sourceRecordId) ?? 0) + 1)`,
    `  invalidateSource(sourceRecordId: string): void {
    this.sourceGenerations.set(sourceRecordId, (this.sourceGenerations.get(sourceRecordId) ?? 0) + 1)
    forgetStandardSourceManifest(sourceRecordId)`,
    'manifest cache invalidation')
  service = replaceOnce(service, `      const context = {
        signal,
        source,
        http,
        media: this.media,
      }`, `      const context = {
        signal,
        source,
        http,
        media: this.media,
        force: options.force === true,
      }`, 'provider query refresh intent')
  service = replaceOnce(service, '      const context = { signal: sourceSignal, source, http, media: this.media }',
    '      const context = { signal: sourceSignal, source, http, media: this.media, force: options.force === true }',
    'catalog scan refresh intent')
  return { adapter, service, types }
}

/** 1) 目录服务：过期快照按 stale 立即返回，不进扫描锁。 */
export function serveStaleCatalogScans(service) {
  // 快照新增第三种状态：内容仍是上一次扫描的，但已过期，正在后台刷新。
  service = replaceOnce(service,
    "function cachedScanView(entry: CatalogFullIndexCacheEntry, cacheStatus: 'fresh' | 'cached'): CatalogFullIndex {",
    "function cachedScanView(entry: CatalogFullIndexCacheEntry, cacheStatus: 'fresh' | 'cached' | 'stale'): CatalogFullIndex {",
    'stale catalog view status')
  service = replaceOnce(service, "  readonly cacheStatus: 'fresh' | 'cached'",
    "  readonly cacheStatus: 'fresh' | 'cached' | 'stale'", 'stale catalog index status')
  service = replaceOnce(service, `export interface CatalogScanOptions {
  readonly force?: boolean`, `export interface CatalogScanOptions {
  /**
   * Product policy: serve an expired scan of the still-active source instead
   * of rebuilding it. The caller refreshes afterwards; only that refresh can
   * block on the provider.
   */
  readonly allowStale?: boolean
  readonly force?: boolean`, 'stale catalog scan option')
  // 强制刷新同样不先清快照：刷新期间界面上就是它，刷新失败后也还是它。
  // 下面的新鲜判定比对 scanGeneration，加一之后旧条目自然算不上新鲜。
  service = replaceOnce(service, `    this.catalogScanGenerations.set(key, generation)
    this.catalogScanCache.delete(key)`, `    this.catalogScanGenerations.set(key, generation)`,
    'stale catalog forced refresh retention')
  // 过期快照不再在扫描前丢掉：刷新期间（以及刷新失败之后）它就是界面上
  // 那份内容，只有来源本身变了（invalidateSource）才作废。scanGeneration
  // 不参与判断——强制刷新会把它加一并撤销旧游标，而这里重新发游标，用的是
  // 仍然校验的 sourceGeneration。
  service = replaceOnce(service, `    if (cached !== undefined) {
      if (this.now() >= cached.expiresAt) this.revokeSourceCursors(source.sourceRecordId)
      this.catalogScanCache.delete(key)
    }`, `    if (cached !== undefined) {
      // Product policy: an expired scan of the still-active source is returned
      // as it stands, marked stale, before the scan lock is taken. Opening
      // Discover therefore renders the last known catalog instead of waiting
      // on a provider that may be sitting behind a hung connection; the client
      // then refreshes with refresh=1 and replaces it.
      if (
        options.allowStale === true
        && options.force !== true
        && cached.sourceGeneration === sourceGeneration
      ) {
        // Refresh insertion order so eviction removes the least recently used scan.
        this.catalogScanCache.delete(key)
        this.catalogScanCache.set(key, cached)
        return cachedScanView(cached, 'stale')
      }
      // The entry itself is kept: it is what a concurrent open is answered
      // from while this scan runs, and what stays on screen if it fails.
      // Cursors issued against it are still revoked once it expires.
      if (this.now() >= cached.expiresAt) this.revokeSourceCursors(source.sourceRecordId)
    }`, 'stale catalog scan reuse')
  service = replaceOnce(service, `      if (cachedAfterWait !== undefined) {
        if (this.now() >= cachedAfterWait.expiresAt) this.revokeSourceCursors(source.sourceRecordId)
        this.catalogScanCache.delete(key)
      }`, `      if (cachedAfterWait !== undefined && this.now() >= cachedAfterWait.expiresAt) {
        this.revokeSourceCursors(source.sourceRecordId)
      }`, 'stale catalog scan retention')
  // 上游注释把"进锁前一定已经删掉缓存条目"当作回收空闲 gate 的依据；
  // 条目改为保留后这个前提不再成立，改写成实际成立的理由。
  service = replaceOnce(service,
    `   * reclaimed; gates for keys with active scans are left alone because the
   * scan flow always removes the cache entry before entering its gate, so an
   * evicted key cannot have an active scan.`,
    `   * reclaimed only when their controller set is empty, and gates for keys
   * with active scans are left alone: the product keeps the last known scan
   * cached while the next one runs, so an evicted key may well have one.`,
    'stale catalog eviction rationale')
  // 查询结果照实标 stale，客户端据此先渲染再后台刷新。
  service = replaceOnce(service,
    '    if (baseSnapshot === undefined) return [{ source: index.source, stale: false }]',
    "    const stale = index.cacheStatus === 'stale'\n"
    + '    if (baseSnapshot === undefined) return [{ source: index.source, stale }]',
    'stale catalog empty query result')
  service = replaceOnce(service, `    return [{
      source: index.source,
      snapshot: this.exposeSnapshot(snapshot, index.source.sourceRecordId, baseQuery, index.sourceGeneration),
      stale: false,
    }]`, `    return [{
      source: index.source,
      snapshot: this.exposeSnapshot(snapshot, index.source.sourceRecordId, baseQuery, index.sourceGeneration),
      stale,
    }]`, 'stale catalog query result')
  return service
}

/** 目录元数据要能表示 stale，客户端与宿主共用这个类型。 */
export function reportStaleCatalogMetadata(types) {
  return replaceOnce(types, "  readonly cacheStatus: 'fresh' | 'cached'",
    "  readonly cacheStatus: 'fresh' | 'cached' | 'stale'", 'stale catalog metadata status')
}

/** 1) 目录路由：非强制刷新允许吃过期快照。 */
export function allowStaleCatalogOnDiscover(routes) {
  return replaceOnce(routes, `          index = await service.scanCatalog(signal, {
            force,`, `          index = await service.scanCatalog(signal, {
            // A plain Discover open takes whatever snapshot exists; only the
            // refresh that follows is allowed to wait on the provider.
            allowStale: !force,
            force,`, 'discover stale scan')
}

/**
 * 上游这条用例逐字断言目录路由传给 scanCatalog 的选项；产品多传一个
 * allowStale，补上即可（断言的本意是"限额与重复 category 原样透传"）。
 */
export function expectStaleScanOptionInRuntimeTest(tests) {
  return replaceOnce(tests,
    "      expect(scanCatalog).toHaveBeenCalledWith(expect.any(AbortSignal), { force: false })",
    "      expect(scanCatalog).toHaveBeenCalledWith(expect.any(AbortSignal), { allowStale: true, force: false })",
    'discover stale scan option test')
}

const MESSAGES = {
  zh: { catalogRefreshFailed: '显示的是上次的插件目录，刷新失败。' },
  en: { catalogRefreshFailed: 'Showing the last known plugin catalog; the refresh failed.' },
}

/** 1) 客户端：后台刷新失败时保留旧目录，并给出可见的重试。 */
export function keepStaleCatalogOnRefreshFailure({ settingsTab, locales }) {
  settingsTab = settingsTab.replaceAll('\r\n', '\n')
  locales = locales.replaceAll('\r\n', '\n')
  settingsTab = replaceOnce(settingsTab, '  const [loadMoreError, setLoadMoreError] = useState<string>()',
    '  const [loadMoreError, setLoadMoreError] = useState<string>()\n'
    + '  const [refreshError, setRefreshError] = useState<string>()',
    'stale catalog refresh state')
  settingsTab = replaceOnce(settingsTab, `    setLoading(true)
    setError(undefined)
    let catalogApplied = false`, `    setLoading(true)
    setError(undefined)
    setRefreshError(undefined)
    let catalogApplied = false`, 'stale catalog refresh reset')
  settingsTab = replaceOnce(settingsTab, `          const refreshed = await readMarketCatalog(
            selected.sourceRecordId,
            effectiveQuery,
            readLocale(),
            categories,
            request.signal,
            true,
          )
          if (!request.signal.aborted && readRequest.current === request) applyCatalog(refreshed)`,
    `          // The cached catalog is already on screen. A refresh that fails
          // has to leave it there and say so, instead of replacing a readable
          // page with an error.
          try {
            const refreshed = await readMarketCatalog(
              selected.sourceRecordId,
              effectiveQuery,
              readLocale(),
              categories,
              request.signal,
              true,
            )
            if (!request.signal.aborted && readRequest.current === request) applyCatalog(refreshed)
          } catch {
            if (!request.signal.aborted && readRequest.current === request) {
              setRefreshError(t('catalogRefreshFailed'))
            }
          }`, 'stale catalog refresh failure')
  settingsTab = insertAfter(settingsTab, `            installations={installations}
            inventoryError={installationsError}
            onRetryInventory={() => { void loadInstallations() }}`,
    `
            refreshError={refreshError}
            onRetryRefresh={() => {
              if (state !== undefined) void loadCatalog(state, appliedQuery, selectedCategories, true)
            }}`, 'stale catalog retry wiring')
  settingsTab = insertAfter(settingsTab, `  installations: readonly MarketInstallationView[]
  inventoryError?: string | undefined
  onRetryInventory: () => void`, `
  refreshError?: string | undefined
  onRetryRefresh: () => void`, 'stale catalog retry props')
  settingsTab = insertAfter(settingsTab, `      {props.inventoryError !== undefined && <div className="dshMarketBanner" role="alert">
        <StateDot state="warning" /><span>{props.inventoryError}</span>
        <Button variant="outline" size="sm" onClick={props.onRetryInventory}>{props.t('retry')}</Button>
      </div>}`, `
      {props.refreshError !== undefined && <div className="dshMarketBanner" role="alert">
        <StateDot state="warning" /><span>{props.refreshError}</span>
        <Button variant="outline" size="sm" onClick={props.onRetryRefresh}>{props.t('retry')}</Button>
      </div>}`, 'stale catalog retry banner')
  for (const [language, entries] of Object.entries(MESSAGES)) {
    const anchor = language === 'zh' ? "  tab: '插件市场'," : "  tab: 'Plugin Market',"
    locales = insertAfter(locales, anchor,
      '\n' + Object.entries(entries).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join('\n'),
      'stale catalog refresh copy')
  }
  return { settingsTab, locales }
}
