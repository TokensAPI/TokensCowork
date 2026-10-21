/* ====================================================================
 * market 覆盖登记表
 * 固定产品来源、当前 Key 鉴权、插件更新、私有 Registry、慢链路下载预算、
 * 发现首页与品牌文案；以及 Desktop 侧的市场提供方固定、侧栏「插件」页只留
 * 产品市场（不露出远程控制卡）、DSH 插件页的安装入口。
 * 同一阶段内按登记顺序执行，后一条读取前一条的结果。
 * ==================================================================== */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desktopFiles as d, desktopInstalled, market as m } from '../../pipeline/stage-targets.mjs'
import { addMarketAuth, skipUpstreamPersistedCatalogTest } from './market-auth-overlay.mjs'
import { pinDesktopMarketProvider } from './market-desktop-overlay.mjs'
import {
  adaptMarketHomeOverlayTests,
  adaptMarketHomeTests,
  adaptMarketHomeTestSetup,
  addMarketHome,
  addMarketHomeStyles,
} from './market-home-overlay.mjs'
import { tolerateSlowDownloads } from './market-network-overlay.mjs'
import {
  expectOfficialMarketHiddenInTest, hideOfficialMarketBundle, hideRemoteControlCard, pinProductMarketOnPluginPage,
} from './market-plugin-controls-overlay.mjs'
import { removePluginPageInstall } from './market-plugin-page-overlay.mjs'
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
    ],
    why: '插件更新与私有 Registry 安装候选的产品回归，由 Market 的 Vitest 在 staging 中执行。',
    retireWhen: '随 market.updates / market.registry 一起移除。',
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
]

/** 本模块不修改 staging 的脚本。 */
export const checks = [
  { file: 'market-catalog-verify.mjs', runBy: 'repo-layout-verify.mjs（产品输入检查自动调用）' },
  { file: 'market-live-regression.mjs', runBy: '手动：联网验证公开目录、归档与真实安装' },
  { file: 'market-private-install-regression.mjs', runBy: '手动：本地夹具验证私有安装与撤权' },
  { file: 'market-agent-cli-regression.mjs', runBy: '手动：原生 CLI 的私有包路由限制' },
]
