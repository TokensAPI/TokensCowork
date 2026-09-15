import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { addMarketAuth, skipUpstreamPersistedCatalogTest } from './market-auth-overlay.mjs'
import { brandMarketCopy } from './market-source-overlay.mjs'
import { addPrivateRegistrySupport } from './market-registry-overlay.mjs'
import { addMarketUpdates, addMarketUpdateChecks, addMarketUpdateUiTests, addMarketUpdateApiTests } from './market-update-overlay.mjs'
import { addRequiredSourceRepairTest, allowMarketSourceSyntheticProxy, awaitProductSourceMigrationInLifecycleTest, pinProductMarketSource, skipUpstreamAddSourceOverlayTests, skipUpstreamBuiltInRuntimeTests, skipUpstreamBuiltInSourceTests, skipUpstreamSourceDescriptionTests } from './market-source-overlay.mjs'

/** Source → auth → updates → private registry → matching product tests. */
export function applyMarketSourceOverlays({ root, stage }) {
  /* -------------------------- 配置插件市场 --------------------------- */
  // 产品插件源部署在 market/server/source.config.json 声明的 origin；为其加入
  // 市场受限 HTTP 客户端的 fake-IP 代理豁免，保证国内代理环境可添加。
  const marketSourceConfig = JSON.parse(readFileSync(resolve(root, 'market', 'server', 'source.config.json'), 'utf8'))
  const marketHttpPath = resolve(stage, 'dsh-community-market', 'src', 'network', 'restricted-http.ts')
  writeFileSync(marketHttpPath, allowMarketSourceSyntheticProxy(
    readFileSync(marketHttpPath, 'utf8'),
    new URL(marketSourceConfig.origin).hostname,
  ))

  // 预置产品目录源为唯一入口：默认选中、隐藏上游合作源与添加/删除入口，
  // 同时精简固定来源页面的说明信息。
  const marketSourceManifest = JSON.parse(readFileSync(resolve(root, 'market', 'server', 'source.json'), 'utf8'))
  const marketIndexPath = resolve(stage, 'dsh-community-market', 'src', 'index.ts')
  const marketRoutesPath = resolve(stage, 'dsh-community-market', 'src', 'host', 'routes.ts')
  const marketSourceStorePath = resolve(stage, 'dsh-community-market', 'src', 'catalog', 'source-store.ts')
  const marketServicePath = resolve(stage, 'dsh-community-market', 'src', 'catalog', 'service.ts')
  const marketSettingsTabPath = resolve(stage, 'dsh-community-market', 'src', 'client', 'MarketSettingsTab.tsx')
  const marketLocalesPath = resolve(stage, 'dsh-community-market', 'src', 'client', 'locales.ts')
  const pinnedMarket = pinProductMarketSource({
    index: readFileSync(marketIndexPath, 'utf8'),
    routes: readFileSync(marketRoutesPath, 'utf8'),
    sourceStore: readFileSync(marketSourceStorePath, 'utf8'),
    service: readFileSync(marketServicePath, 'utf8'),
    settingsTab: readFileSync(marketSettingsTabPath, 'utf8'),
    locales: readFileSync(marketLocalesPath, 'utf8'),
  }, marketSourceConfig.origin, marketSourceManifest)
  writeFileSync(marketIndexPath, pinnedMarket.index)
  writeFileSync(marketRoutesPath, pinnedMarket.routes)
  writeFileSync(marketSourceStorePath, pinnedMarket.sourceStore)
  writeFileSync(marketServicePath, pinnedMarket.service)
  writeFileSync(marketSettingsTabPath, pinnedMarket.settingsTab)
  writeFileSync(marketLocalesPath, pinnedMarket.locales)
  const authenticatedMarket = addMarketAuth({
    index: readFileSync(marketIndexPath, 'utf8'),
    http: readFileSync(marketHttpPath, 'utf8'),
    routes: readFileSync(marketRoutesPath, 'utf8'),
  }, marketSourceConfig.origin)
  writeFileSync(marketHttpPath, authenticatedMarket.http)
  writeFileSync(marketRoutesPath, authenticatedMarket.routes)
  writeFileSync(marketIndexPath, authenticatedMarket.index)

  /* ----------------------- 适配固定市场源测试 ------------------------ */
  // 产品只暴露一个固定目录源；跳过上游多来源管理用例，并保留产品源迁移、
  // 自愈测试。插件安装与卸载测试继续完整运行上游最新版行为。
  const marketHostTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'host-routes.spec.ts')
  writeFileSync(marketHostTestsPath, skipUpstreamBuiltInSourceTests(readFileSync(marketHostTestsPath, 'utf8')))
  writeFileSync(marketHostTestsPath, skipUpstreamPersistedCatalogTest(readFileSync(marketHostTestsPath, 'utf8')))
  const marketRuntimeTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-runtime.spec.ts')
  writeFileSync(marketRuntimeTestsPath, skipUpstreamBuiltInRuntimeTests(readFileSync(marketRuntimeTestsPath, 'utf8')))
  const marketOverlayTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'client-overlay.spec.tsx')
  writeFileSync(marketOverlayTestsPath, skipUpstreamAddSourceOverlayTests(readFileSync(marketOverlayTestsPath, 'utf8')))
  const marketSettingsTabTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-settings-tab.spec.tsx')
  writeFileSync(
    marketSettingsTabTestsPath,
    skipUpstreamSourceDescriptionTests(readFileSync(marketSettingsTabTestsPath, 'utf8')),
  )
  const marketUpdatePaths = {
    service: resolve(stage, 'dsh-community-market', 'src', 'install', 'service.ts'),
    routes: marketRoutesPath,
    types: resolve(stage, 'dsh-community-market', 'src', 'api-types.ts'),
    settingsTab: marketSettingsTabPath,
    locales: marketLocalesPath,
  }
  const marketUpdates = addMarketUpdates(Object.fromEntries(
    Object.entries(marketUpdatePaths).map(([key, path]) => [key, readFileSync(path, 'utf8')]),
  ))
  for (const [key, path] of Object.entries(marketUpdatePaths)) writeFileSync(path, marketUpdates[key])

  /* ----------------------- 可选私有 Registry 适配 -------------------- */
  // 只在 staging 中扩展上游的 npm identity/安装验证契约。公开 npm 仍使用
  // 上游固定 registry；私有来源经由产品市场的授权代理，Registry Secret
  // 永远只存在 Worker 环境变量中。
  const marketPrivateRegistry = addPrivateRegistrySupport({
    http: readFileSync(marketHttpPath, 'utf8'),
    index: readFileSync(marketIndexPath, 'utf8'),
    service: readFileSync(marketUpdatePaths.service, 'utf8'),
    routes: readFileSync(marketUpdatePaths.routes, 'utf8'),
    identity: readFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'identity.ts'), 'utf8'),
    types: readFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'types.ts'), 'utf8'),
    providerSchema: readFileSync(resolve(stage, 'dsh-community-market', 'docs', 'schemas', 'catalog-provider-page.schema.json'), 'utf8'),
    snapshotSchema: readFileSync(resolve(stage, 'dsh-community-market', 'docs', 'schemas', 'catalog-snapshot.schema.json'), 'utf8'),
    providerTypes: readFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'generated', 'catalog-provider-page.ts'), 'utf8'),
    snapshotTypes: readFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'generated', 'catalog-snapshot.ts'), 'utf8'),
  }, marketSourceConfig.origin)
  cpSync(resolve(root, 'build', 'modules', 'market', 'market-registry-candidates.spec.ts'),
    resolve(stage, 'dsh-community-market', 'tests', 'market-registry-candidates.spec.ts'))
  writeFileSync(marketHttpPath, marketPrivateRegistry.http)
  writeFileSync(marketIndexPath, marketPrivateRegistry.index)
  writeFileSync(marketUpdatePaths.service, marketPrivateRegistry.service)
  writeFileSync(marketUpdatePaths.routes, marketPrivateRegistry.routes)
  writeFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'identity.ts'), marketPrivateRegistry.identity)
  writeFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'types.ts'), marketPrivateRegistry.types)
  writeFileSync(resolve(stage, 'dsh-community-market', 'docs', 'schemas', 'catalog-provider-page.schema.json'), marketPrivateRegistry.providerSchema)
  writeFileSync(resolve(stage, 'dsh-community-market', 'docs', 'schemas', 'catalog-snapshot.schema.json'), marketPrivateRegistry.snapshotSchema)
  writeFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'generated', 'catalog-provider-page.ts'), marketPrivateRegistry.providerTypes)
  writeFileSync(resolve(stage, 'dsh-community-market', 'src', 'contracts', 'generated', 'catalog-snapshot.ts'), marketPrivateRegistry.snapshotTypes)
  const marketClientApiPath = resolve(stage, 'dsh-community-market', 'src', 'client', 'api.ts')
  writeFileSync(marketClientApiPath, addMarketUpdateChecks(readFileSync(marketClientApiPath, 'utf8')))
  writeFileSync(marketSettingsTabTestsPath, addMarketUpdateUiTests(readFileSync(marketSettingsTabTestsPath, 'utf8')))
  const marketClientApiTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'client-api.spec.ts')
  writeFileSync(marketClientApiTestsPath, addMarketUpdateApiTests(readFileSync(marketClientApiTestsPath, 'utf8')))
  cpSync(resolve(root, 'build', 'modules', 'market', 'market-update.spec.ts'),
    resolve(stage, 'dsh-community-market', 'tests', 'market-update.spec.ts'))
  const marketSourceStoreTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'source-store.spec.ts')
  writeFileSync(
    marketSourceStoreTestsPath,
    addRequiredSourceRepairTest(readFileSync(marketSourceStoreTestsPath, 'utf8')),
  )
  const marketLifecycleTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-host-lifecycle.spec.ts')
  writeFileSync(
    marketLifecycleTestsPath,
    awaitProductSourceMigrationInLifecycleTest(readFileSync(marketLifecycleTestsPath, 'utf8')),
  )
  // Last, so update overlays cannot reintroduce upstream UI copy.
  const { product } = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
  writeFileSync(marketLocalesPath, brandMarketCopy(readFileSync(marketLocalesPath, 'utf8'), product.name))
}
