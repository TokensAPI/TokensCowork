/* ====================================================================
 * market 覆盖登记表
 * 固定产品来源、当前 Key 鉴权、插件更新、私有 Registry、慢链路下载预算、
 * 发现首页与品牌文案、发现页首屏延迟（过期快照先显示、远程请求快速失败、
 * 清单按来源缓存）；以及 Desktop 侧的市场提供方固定、侧栏「插件」页只留
 * 产品市场（不露出远程控制卡）、DSH 插件页的安装入口。
 * 同一阶段内按登记顺序执行，后一条读取前一条的结果。
 * ==================================================================== */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desktopFiles as d, desktopInstalled, market as m } from '../../pipeline/stage-targets.mjs'
import { addMarketAuth, skipUpstreamPersistedCatalogTest } from './market-auth-overlay.mjs'
import {
  addOfficialPluginMarketOffTest, pinDesktopMarketProvider, pinDesktopOfficialPluginMarketOff,
} from './market-desktop-overlay.mjs'
import {
  allowStaleCatalogOnDiscover,
  cacheStandardSourceManifests,
  expectStaleScanOptionInRuntimeTest,
  failFastOnCatalogRequests,
  keepStaleCatalogOnRefreshFailure,
  reportStaleCatalogMetadata,
  serveStaleCatalogScans,
} from './market-discover-latency-overlay.mjs'
import {
  adaptMarketHomeOverlayTests,
  adaptMarketHomeTests,
  adaptMarketHomeTestSetup,
  addMarketHome,
  addMarketHomeStyles,
  addMarketPluginsTab,
  expectPluginsTabInClientTest,
} from './market-home-overlay.mjs'
import { tolerateSlowDownloads } from './market-network-overlay.mjs'
import {
  expectOfficialMarketHiddenInTest, hideOfficialMarketBundle, hideRemoteControlCard, pinProductMarketOnPluginPage,
} from './market-plugin-controls-overlay.mjs'
import { hidePluginPageSidebarEntry, removePluginPageInstall } from './market-plugin-page-overlay.mjs'
import { addMarketRestartPrompt, addMarketRestartUiTests } from './market-restart-overlay.mjs'
import { addPrivateRegistrySupport, adaptUpstreamInstallSpecs } from './market-registry-overlay.mjs'
import {
  addRequiredSourceRepairTest,
  allowMarketSourceSyntheticProxy,
  awaitProductSourceMigrationInLifecycleTest,
  brandMarketCopy,
  pinProductMarketSource,
  skipUpstreamAddSourceOverlayTests,
  skipUpstreamBuiltInRuntimeTests,
  skipUpstreamBuiltInSourceTests,
  skipUpstreamSourceDescriptionTests,
} from './market-source-overlay.mjs'
import { addMarketUpdateChecks, addMarketUpdates, addMarketUpdateUiTests } from './market-update-overlay.mjs'

/** 市场服务的产品来源配置与生成的来源清单。 */
const source = root => ({
  origin: JSON.parse(readFileSync(resolve(root, 'market/server/source.config.json'), 'utf8')).origin,
  manifest: JSON.parse(readFileSync(resolve(root, 'market/server/source.json'), 'utf8')),
})
const template = name => resolve(import.meta.dirname, name)
const pluginPageClient = desktopInstalled('@deepseek-ai/dsh-client-ui-plugin-manager', 'lib/client.js')
/** Desktop 客户端源码；只有市场相关的两个文件，不登记进 stage-targets。 */
const desktopClient = file => `dsh-plugin-desktop/src/client/${file}`
/** Desktop 的 Profile 装配与它的用例；只有市场的官方市场关闭覆盖用到，不登记进 stage-targets。 */
const desktopProfile = 'dsh-plugin-desktop/src/profile.ts'
const desktopProfileTests = 'dsh-plugin-desktop/tests/profile.spec.ts'

const f = {
  http: m('src/network/restricted-http.ts'),
  index: m('src/index.ts'),
  routes: m('src/host/routes.ts'),
  settingsTab: m('src/client/MarketSettingsTab.tsx'),
  locales: m('src/client/locales.ts'),
  styles: m('src/client/styles.ts'),
  api: m('src/client/api.ts'),
  installService: m('src/install/service.ts'),
  apiTypes: m('src/api-types.ts'),
  catalogService: m('src/catalog/service.ts'),
  standardAdapter: m('src/adapters/standard-http.ts'),
  contractTypes: m('src/contracts/types.ts'),
}

const sourceEntry = (id, overlay) => ({
  phase: 'prepare',
  upstream: ['desktop', 'market-server'],
  ...overlay,
  id: `market.${id}`,
})

export default [
  /* ----------------------- 来源与网络 ----------------------- */
  sourceEntry('synthetic-proxy', {
    kind: 'compatibility',
    files: { http: f.http },
    apply: ({ http }, { root }) => ({ http: allowMarketSourceSyntheticProxy(http, new URL(source(root).origin).hostname) }),
    why: '只给产品市场域名放行 fake-IP 代理地址，并适配 IPv6 假地址；其他域名仍走上游 SSRF 限制。',
    retireWhen: '上游能显式配置可信域名，且通过相同网络与安全测试后删除。',
  }),
  sourceEntry('pin-source', {
    kind: 'customization',
    files: {
      index: f.index, routes: f.routes, settingsTab: f.settingsTab, locales: f.locales,
      sourceStore: m('src/catalog/source-store.ts'), service: m('src/catalog/service.ts'),
    },
    apply: (input, { root }) => pinProductMarketSource(input, source(root).origin, source(root).manifest),
    why: '固定唯一产品来源，内存启动与持久化接管后都修复旧来源，隐藏来源增删与说明。',
    retireWhen: '只有产品改回多来源策略才移除。',
  }),
  /* ----------------------- 鉴权 ----------------------- */
  sourceEntry('auth', {
    kind: 'customization',
    upstream: ['desktop', 'market-server', 'plugin:tokens-login', 'plugin:tokens-model-manager'],
    files: { index: f.index, http: f.http, routes: f.routes },
    apply: (input, { root }) => addMarketAuth(input, source(root).origin),
    why: '按当前 API Key 请求产品目录，切换 Key 时缓存失效、授权目录不落盘，重定向到第三方不携带凭据。',
    retireWhen: '上游提供等效的按用户授权与缓存隔离扩展点后改走配置，并保留重定向泄漏回归。',
  }),
  /* ----------------------- 插件更新 ----------------------- */
  sourceEntry('updates', {
    kind: 'customization',
    files: { service: f.installService, routes: f.routes, types: f.apiTypes, settingsTab: f.settingsTab, locales: f.locales },
    apply: input => addMarketUpdates(input),
    why: '上游没有"有新版本"的提示也没有更新动作；对授权目录仍在售的 npm 插件提供检查、确认与执行更新，更新按官方插件页同一语义先卸载再安装，插件配置与选中状态保留。',
    retireWhen: '上游自己提供更新检查与更新动作，并通过产品行为测试后移除。',
  }),
  /* ----------------------- 私有 Registry ----------------------- */
  sourceEntry('registry', {
    kind: 'customization',
    files: {
      http: f.http, index: f.index, service: f.installService, routes: f.routes,
      identity: m('src/contracts/identity.ts'),
      types: m('src/contracts/types.ts'),
      providerSchema: m('docs/schemas/catalog-provider-page.schema.json'),
      snapshotSchema: m('docs/schemas/catalog-snapshot.schema.json'),
      providerTypes: m('src/contracts/generated/catalog-provider-page.ts'),
      snapshotTypes: m('src/contracts/generated/catalog-snapshot.ts'),
    },
    apply: (input, { root }) => addPrivateRegistrySupport(input, source(root).origin),
    why: '支持 tokenscowork 私有包身份、schema、版本验证与共享 Registry 安装路由，保留每插件授权；服务端凭据留在服务端。',
    retireWhen: '上游支持等效 Registry 身份与安装路由后改用原生扩展；公开 npm 与私有包都要回归。',
  }),
  sourceEntry('update-checks-api', {
    kind: 'customization',
    files: { api: f.api },
    apply: ({ api }) => ({ api: addMarketUpdateChecks(api) }),
    why: '客户端 API 增加插件更新检查调用。',
    retireWhen: '随 market.updates 一起移除。',
  }),
  /* ----------------------- 慢网络 ----------------------- */
  sourceEntry('slow-network', {
    kind: 'customization',
    files: { service: f.installService, routes: f.routes, settingsTab: f.settingsTab, locales: f.locales },
    apply: input => tolerateSlowDownloads(input),
    why: '插件包整包走一次 pnpm 请求，默认 60 秒预算在慢链路上必然超时；放宽进程内的下载预算（不改写 Profile 的 pnpm 配置），并把超时失败显示成网络提示而不是“包管理器未成功完成”，详细输出保留。',
    retireWhen: '上游自己为插件下载设置足够的预算并区分超时失败后移除。',
  }),
  /* ----------------------- 发现首页与文案 ----------------------- */
  sourceEntry('discover-home', {
    kind: 'customization',
    files: { settingsTab: f.settingsTab, locales: f.locales },
    apply: input => addMarketHome(input),
    why: '默认进入原生发现页，按本地安装清单把已安装卡片整体置灰；详情自动检查更新，失败才显示重试。',
    retireWhen: '上游提供相同发现入口、安装标识和详情更新操作，并通过产品回归时移除。',
  }),
  sourceEntry('discover-home-styles', {
    kind: 'customization',
    files: { styles: f.styles },
    apply: ({ styles }) => ({ styles: addMarketHomeStyles(styles) }),
    why: '已安装卡片的灰色样式；不改原生布局。',
    retireWhen: '随 market.discover-home 一起移除。',
  }),
  sourceEntry('plugins-page-discover-tab', {
    kind: 'customization',
    // dsh：这一格的 Slot 契约（kind/scope/owner）照 dsh-client-ui-plugin-manager 就地声明，
    // 市场包不依赖那个包，所以 DSH 升级要连它一起复查。
    upstream: ['desktop', 'market-server', 'dsh'],
    files: { clientIndex: m('src/client/index.ts'), settingsTab: f.settingsTab },
    apply: input => addMarketPluginsTab(input),
    why: '侧栏「插件」页的「发现」标签原本由官方「自定义插件市场」bundle 提供，要用户自己添加索引源（真机上就是一个「还没有插件市场」的空壳）；产品固定关掉那个 bundle 后由产品市场接上这一格，复用同一个发现面板，目录走产品固定的私有源、安装走市场自己的流程。',
    retireWhen: '产品不再在插件页提供发现入口，或上游把这一页的发现标签改为可配置的产品市场时移除。',
  }),
  /* ----------------------- 发现页首屏延迟 ----------------------- */
  sourceEntry('catalog-fast-fail', {
    kind: 'customization',
    files: { http: f.http },
    apply: ({ http }) => ({ http: failFastOnCatalogRequests(http) }),
    why: '目录扫描按来源串行，上游单次远程请求的总预算是 30 s；用户机器经本地代理时偶发握手挂起十几秒，一条挂住的连接把后续每次打开都排在它后面——真机上就是「发现」转几十秒然后突然好。只把产品目录源那个受限客户端的预算收到 8 s（代理下正常一次请求约 1.1 s），1024Store、dshfind 与 npm Registry 的客户端保持上游默认。',
    retireWhen: '上游自己为目录请求设置可配置且足够短的预算后移除。',
  }),
  sourceEntry('catalog-manifest-cache', {
    kind: 'customization',
    files: { adapter: f.standardAdapter, service: f.catalogService, types: f.contractTypes },
    apply: (input, { root }) => cacheStandardSourceManifests(input, source(root).origin),
    why: 'source.json 只带提供方身份与查询端点（随产品发版才变），上游却在每次目录扫描前重拉一次：代理下这一跳要多付约 0.8 s 握手，首次打开因此是两跳 1.5 s。产品来源改为按来源缓存 24 h，并以来源记录里那份注册时已校验的固定清单起步（产品自己构建并托管这份清单，记录里那份就是发出去的那份），首次扫描降到一跳；两条不变量（提供方身份、查询端点在注册 origin 内）在每条路径上都重新校验，用户按刷新时绕过缓存重读。只认产品 origin：用户自添的标准源仍按上游语义每次重读，清单漂移照旧当场发现。',
    retireWhen: '上游自己缓存清单或支持 ETag/If-None-Match 后移除。',
  }),
  sourceEntry('catalog-stale-first', {
    kind: 'customization',
    // 必须在 market.discover-home 之后：客户端两处锚点是它切出 DiscoverView 时的产物。
    files: {
      service: f.catalogService, routes: f.routes, types: f.apiTypes,
      settingsTab: f.settingsTab, locales: f.locales,
    },
    apply: ({ service, routes, types, settingsTab, locales }) => ({
      service: serveStaleCatalogScans(service),
      routes: allowStaleCatalogOnDiscover(routes),
      types: reportStaleCatalogMetadata(types),
      ...keepStaleCatalogOnRefreshFailure({ settingsTab, locales }),
    }),
    why: '上游在内存快照过期后丢掉它、进扫描锁重建，于是「发现」每次过期都要等一次远程扫描，挂住就一直转。改为过期但来源未变的快照立即按 stale 返回、不进扫描锁，界面先渲染上次的目录，再由客户端已有的 refresh=1 在后台替换；刷新失败保留旧内容并给出可见的重试，而不是把能看的页面换成错误页。',
    retireWhen: '上游自己先返回过期快照再后台刷新后移除。',
  }),
  sourceEntry('test-stale-scan-option', {
    kind: 'customization',
    files: { tests: m('tests/market-runtime.spec.ts') },
    apply: ({ tests }) => ({ tests: expectStaleScanOptionInRuntimeTest(tests) }),
    why: '上游用例逐字断言目录路由传给 scanCatalog 的选项，产品多传一个 allowStale；断言的本意（限额与重复 category 原样透传）不变，补上这一项。',
    retireWhen: '随 market.catalog-stale-first 一起移除。',
  }),
  /* ----------------------- 更新后的重启提示 ----------------------- */
  sourceEntry('restart-prompt', {
    kind: 'customization',
    files: {
      types: f.apiTypes, service: f.installService, routes: f.routes, index: f.index,
      api: f.api, settingsTab: f.settingsTab, locales: f.locales, styles: f.styles,
    },
    apply: input => addMarketRestartPrompt(input),
    why: '官方插件管理器只热替换插件自己的模块：插件依赖的共享模块（真机上是 undici）已在本进程加载时，宿主 HMR 以 module-comparison 为由沿用旧代码，插件跑在「新代码 + 旧依赖」上（连接中心 2.9.6→2.9.7 更新后微信入站仍按旧版失败，重启才好）。宿主已经把它报成 ChangeResult 的 restart-required + restartReason，市场却只把它接成一条几秒就消失的 Toast 文案，既不说是哪个插件也没有重启入口。把 restartReason 透传到渲染层，面板顶部常驻横幅列出待重启的插件，并用宿主已有的 desktopActions.requestRestart() 提供「立即重启」；application 为 applied 时不提示。',
    retireWhen: '上游自己在市场界面给出待重启插件与重启入口，或官方管理器能连同共享依赖一起热替换后移除。',
  }),
  sourceEntry('brand-copy', {
    kind: 'customization',
    upstream: ['desktop', 'product'],
    files: { locales: f.locales },
    apply: ({ locales }, { product }) => ({ locales: brandMarketCopy(locales, product.product.name) }),
    why: '所有市场覆盖完成后，统一替换中英文安装、卸载、更新与重启文案中的上游品牌。',
    retireWhen: '产品使用独立品牌期间保留。',
  }),
  /* ----------------------- 上游测试适配与产品回归 ----------------------- */
  sourceEntry('test-builtin-source', {
    kind: 'customization',
    files: { tests: m('tests/host-routes.spec.ts') },
    apply: ({ tests }) => ({ tests: skipUpstreamBuiltInSourceTests(tests) }),
    why: '产品只有一个固定来源，跳过上游内置多来源路由用例；产品行为由补充用例覆盖。',
    retireWhen: '随 market.pin-source 一起移除。',
  }),
  sourceEntry('test-persisted-catalog', {
    kind: 'customization',
    files: { tests: m('tests/host-routes.spec.ts') },
    apply: ({ tests }) => ({ tests: skipUpstreamPersistedCatalogTest(tests) }),
    why: '授权目录不落盘，跳过上游持久化目录用例。',
    retireWhen: '随 market.auth 一起移除。',
  }),
  sourceEntry('test-builtin-runtime', {
    kind: 'customization',
    files: { tests: m('tests/market-runtime.spec.ts') },
    apply: ({ tests }) => ({ tests: skipUpstreamBuiltInRuntimeTests(tests) }),
    why: '跳过上游内置来源的运行时用例。',
    retireWhen: '随 market.pin-source 一起移除。',
  }),
  sourceEntry('test-add-source-ui', {
    kind: 'customization',
    files: { tests: m('tests/client-overlay.spec.tsx') },
    apply: ({ tests }) => ({ tests: skipUpstreamAddSourceOverlayTests(tests) }),
    why: '来源增删界面已隐藏，跳过对应界面用例。',
    retireWhen: '随 market.pin-source 一起移除。',
  }),
  sourceEntry('test-discover-overlay', {
    kind: 'customization',
    files: { tests: m('tests/client-overlay.spec.tsx') },
    apply: ({ tests }) => ({ tests: adaptMarketHomeOverlayTests(tests) }),
    why: '默认视图改为发现页后，调整上游浮层用例的进入方式。',
    retireWhen: '随 market.discover-home 一起移除。',
  }),
  sourceEntry('test-client-registration', {
    kind: 'customization',
    files: { tests: m('tests/client-api.spec.ts') },
    apply: ({ tests }) => ({ tests: expectPluginsTabInClientTest(tests) }),
    why: '上游注册用例按次序断言市场客户端的三条 Slot 注册；产品多注册一条插件页「发现」标签，追加第四条断言。',
    retireWhen: '随 market.plugins-page-discover-tab 一起移除。',
  }),
  sourceEntry('test-setup', {
    kind: 'customization',
    files: { setup: m('tests/setup.tsx') },
    apply: ({ setup }) => ({ setup: adaptMarketHomeTestSetup(setup) }),
    why: '测试环境补充发现页依赖的本地安装清单桩。',
    retireWhen: '随 market.discover-home 一起移除。',
  }),
  sourceEntry('test-source-description', {
    kind: 'customization',
    files: { tests: m('tests/market-settings-tab.spec.tsx') },
    apply: ({ tests }) => ({ tests: skipUpstreamSourceDescriptionTests(tests) }),
    why: '来源说明已隐藏，跳过对应设置页用例。',
    retireWhen: '随 market.pin-source 一起移除。',
  }),
  sourceEntry('test-update-ui', {
    kind: 'customization',
    files: { tests: m('tests/market-settings-tab.spec.tsx') },
    apply: ({ tests }) => ({ tests: addMarketUpdateUiTests(tests) }),
    why: '设置页补充插件更新界面的产品回归。',
    retireWhen: '随 market.updates 一起移除。',
  }),
  sourceEntry('test-discover-home', {
    kind: 'customization',
    files: { tests: m('tests/market-settings-tab.spec.tsx') },
    apply: ({ tests }) => ({
      tests: adaptMarketHomeTests(tests) + readFileSync(template('market-home-ui-tests.inc'), 'utf8'),
    }),
    why: '调整上游设置页用例的默认视图，并追加发现页、灰色卡片、自动检查与重试的产品回归（market-home-ui-tests.inc）。',
    retireWhen: '随 market.discover-home 一起移除。',
  }),
  sourceEntry('test-restart-ui', {
    kind: 'customization',
    // 排在 market.test-discover-home 之后：横幅会一直留在页面上，产品回归要排在
    // 上游和发现页用例的最后，不影响它们的断言。
    files: { tests: m('tests/market-settings-tab.spec.tsx') },
    apply: ({ tests }) => ({ tests: addMarketRestartUiTests(tests) }),
    why: '设置页补充「更新后需重启」横幅的产品回归：宿主报 restart-required + module-comparison 时说出是哪个插件、为什么要重启并能一键重启，宿主没给原因时退回通用文案，宿主即时生效时不提示，重新挂载时按状态端点报的清单恢复横幅；同时给上游显式列举的 api.js 替身补上新导出。',
    retireWhen: '随 market.restart-prompt 一起移除。',
  }),
  sourceEntry('test-source-repair', {
    kind: 'customization',
    files: { tests: m('tests/market-state-persistence.spec.ts') },
    apply: ({ tests }) => ({ tests: addRequiredSourceRepairTest(tests) }),
    why: '补充旧来源自愈的产品回归。',
    retireWhen: '随 market.pin-source 一起移除。',
  }),
  sourceEntry('test-lifecycle-migration', {
    kind: 'customization',
    files: { tests: m('tests/host-routes.spec.ts') },
    apply: ({ tests }) => ({ tests: awaitProductSourceMigrationInLifecycleTest(tests) }),
    why: '生命周期用例等待产品来源迁移完成后再断言。',
    retireWhen: '随 market.pin-source 一起移除。',
  }),
  sourceEntry('test-upstream-install-specs', {
    kind: 'customization',
    upstream: ['desktop'],
    files: { install: m('tests/market-install.spec.ts'), github: m('tests/github-install.spec.ts') },
    apply: ({ install, github }) => ({
      install: adaptUpstreamInstallSpecs(install),
      github: adaptUpstreamInstallSpecs(github),
    }),
    why: '上游安装用例的 profile 目录是假路径，且不认产品固定的 npm registry 选项。',
    retireWhen: '随 market.registry 一起移除，或上游自己用真实临时目录并带上 registry。',
  }),
  sourceEntry('test-product-specs', {
    kind: 'customization',
    upstream: ['desktop'],
    copy: [
      [template('market-update.spec.ts'), m('tests/market-update.spec.ts')],
      [template('market-registry-candidates.spec.ts'), m('tests/market-registry-candidates.spec.ts')],
      [template('market-discover-latency.spec.ts'), m('tests/market-discover-latency.spec.ts')],
    ],
    why: '插件更新、私有 Registry 安装候选与「发现」首屏延迟的产品回归，由 Market 的 Vitest 在 staging 中执行。',
    retireWhen: '随 market.updates / market.registry / market.catalog-stale-first 一起移除。',
  }),
  /* ----------------------- Desktop 侧 ----------------------- */
  {
    id: 'market.desktop-provider',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { main: d.main },
    apply: ({ main }) => ({ main: pinDesktopMarketProvider(main) }),
    why: '正常启动固定 community-market 并修复误关的持久记录（崩溃恢复会把 disabled 写盘）；Safe Mode 例外。',
    retireWhen: '产品不再固定市场，或上游提供等效策略配置时移除；不能丢失其他偏好字段。',
  },
  {
    id: 'market.desktop-official-market-off',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { main: d.main, profile: desktopProfile },
    apply: ({ main, profile }) => pinDesktopOfficialPluginMarketOff(main, profile),
    why: '官方「自定义插件市场」bundle 在 0.7.0 可以从插件页的「更多」清单点开，T0037 把那个入口藏掉之后，已经开过它的 Profile 界面上再没有地方关掉，于是永久卡在上游那个要用户自己「添加索引源」的「发现」空壳上。正常启动一律调上游 configureDesktopOfficialPluginMarket(dir, false) 关掉，并清掉它预置到 cordis.patch.yml 的索引源；Safe Mode 诊断会话不改 Profile。',
    retireWhen: '产品决定支持用户自定义插件市场索引，或上游给这个 bundle 提供产品级禁用配置时移除。',
  },
  {
    id: 'market.desktop-official-market-off-test',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { tests: desktopProfileTests },
    apply: ({ tests }) => ({ tests: addOfficialPluginMarketOffTest(tests) }),
    why: '构建模块自己的回归没有 yaml 依赖，只能校验锚点落点；关闭 bundle 连同清理预置索引源的实际行为由这份补进上游 Profile 用例的产品回归在 staging 的 Desktop Vitest 里跑真实 yaml。',
    retireWhen: '随 market.desktop-official-market-off 一起移除。',
  },
  {
    id: 'market.plugin-page-single-market',
    phase: 'prepare',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: { controls: desktopClient('plugin-controls.tsx') },
    apply: ({ controls }, { product }) => ({ controls: pinProductMarketOnPluginPage(controls, product.product.name) }),
    why: 'Desktop 2.0.18 的侧栏「插件」页把 community-market 与 dsh-market 并排成卡，并给出「来源配置」弹窗（dshmarket / dshfind / deepseek1024 等非产品源与官方自定义插件市场）和「启用插件市场」开关；产品只有一个固定市场，切走只在当次会话生效、关掉下次启动又被 market.desktop-provider 改回来。收敛为一张产品市场卡，文案用产品名、不带上游仓库外链。',
    retireWhen: '产品改回多来源/多市场策略，或上游为这一页提供与设置页同样的 capability 开关时移除。',
  },
  {
    id: 'market.plugin-page-hide-remote-control',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    // 与上一条同文件：先收敛市场区，再去掉远程控制卡。
    files: { controls: desktopClient('plugin-controls.tsx') },
    apply: ({ controls }) => ({ controls: hideRemoteControlCard(controls) }),
    why: 'Agents Anywhere 随包分发但产品不露出入口（侧栏入口早已藏掉），2.0.18 又在插件页给它一张带启用开关和「打开面板」的卡。只藏界面，不改 bundle 的启停状态与运行时行为，与产品既有口径一致。',
    retireWhen: '产品决定正式提供远程控制功能时移除。',
  },
  {
    id: 'market.plugin-page-hide-official-market',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: {
      settings: desktopClient('desktop-settings.ts'),
      tests: 'dsh-plugin-desktop/tests/client-desktop-settings.spec.ts',
    },
    apply: ({ settings, tests }) => ({
      settings: hideOfficialMarketBundle(settings),
      tests: expectOfficialMarketHiddenInTest(tests),
    }),
    why: '官方「自定义插件市场」bundle 在上游 MORE_BUNDLES 里，插件页「更多」清单从一开始就显示它，开启后再挂一个按用户自添索引的「发现」页——又一个与产品市场并列的入口。沿用上游已有的 plugins.bundle.hidden 机制一起挡掉，并给上游按注册次序断言的用例补上第四条。',
    retireWhen: '随 market.plugin-page-single-market 一起移除，或产品决定支持用户自定义插件市场索引时移除。',
  },
  /* ----------------------- DSH 插件页 ----------------------- */
  {
    id: 'market.plugin-page-install',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'customization',
    // 没装这个包就没有插件页，也就没有安装入口：跳过而不是报错（--doctor 显示为“未启用”）。
    // 只在包存在时执行，锚点失配照常让构建失败。
    when: ({ files }) => files.has(pluginPageClient),
    files: { client: pluginPageClient },
    apply: ({ client }) => ({ client: removePluginPageInstall(client) }),
    why: '插件安装统一走插件市场。DSH 0.2 侧栏“插件”页的“添加插件”可按 npm 包名、Git 地址或本地目录直接安装，绕过私有 Registry、版本与兼容性检查；去掉该按钮并让 openInstall 不再打开安装对话框，刷新、启停、配置与卸载保留。',
    retireWhen: '上游提供关闭安装入口的配置，或该页安装改为走产品插件市场时移除。',
  },
  {
    id: 'market.plugin-page-sidebar-entry',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'customization',
    // 与 market.plugin-page-install 同一个文件、同样的启用条件：没装这个包就没有这个入口。
    when: ({ files }) => files.has(pluginPageClient),
    files: { client: pluginPageClient },
    apply: ({ client }) => ({ client: hidePluginPageSidebarEntry(client) }),
    why: '插件统一从侧栏底部的「插件市场」管理，侧栏再放一个「插件」是重复入口（用户 2026-10-29 要求收掉）。只去掉 sidebar.panellist 导航项：插件页照常注册，设置页「前往插件页」与插件详情跳转仍可达，所以本页其余覆盖（去「添加插件」、收敛市场卡、藏远程控制与官方市场）必须保留，否则这些入口会从后门回来。',
    retireWhen: '产品重新在侧栏露出插件页，或上游提供关闭该导航项的配置时移除。',
  },
]

/** 本模块不修改 staging 的脚本。 */
export const checks = [
  { file: 'market-catalog-verify.mjs', runBy: 'repo-layout-verify.mjs（产品输入检查自动调用）' },
  { file: 'market-live-regression.mjs', runBy: '手动：联网验证公开目录、归档与真实安装' },
  { file: 'market-private-install-regression.mjs', runBy: '手动：本地夹具验证私有安装与撤权' },
  { file: 'market-agent-cli-regression.mjs', runBy: '手动：原生 CLI 的私有包路由限制' },
]
