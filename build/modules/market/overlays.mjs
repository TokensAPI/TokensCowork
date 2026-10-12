/* ====================================================================
 * market 覆盖登记表
 * 固定产品来源、当前 Key 鉴权、插件更新、私有 Registry、发现首页与
 * 品牌文案；以及 Desktop 侧的市场提供方固定。
 * 同一阶段内按登记顺序执行，后一条读取前一条的结果。
 * ==================================================================== */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desktopFiles as d, market as m } from '../../pipeline/stage-targets.mjs'
import { addMarketAuth, skipUpstreamPersistedCatalogTest } from './market-auth-overlay.mjs'
import { pinDesktopMarketProvider } from './market-desktop-overlay.mjs'
import {
  adaptMarketHomeOverlayTests,
  adaptMarketHomeTests,
  adaptMarketHomeTestSetup,
  addMarketHome,
  addMarketHomeStyles,
} from './market-home-overlay.mjs'
import { addPrivateRegistrySupport } from './market-registry-overlay.mjs'
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
    why: '对可管理的 npm 插件提供检查、确认与执行更新，保留 Profile 配置、启用状态与重启提示。',
    retireWhen: '上游具备同等更新、权限、确认与重启语义，并通过产品行为测试后移除。',
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
    files: { tests: m('tests/source-store.spec.ts') },
    apply: ({ tests }) => ({ tests: addRequiredSourceRepairTest(tests) }),
    why: '补充旧来源自愈的产品回归。',
    retireWhen: '随 market.pin-source 一起移除。',
  }),
  sourceEntry('test-lifecycle-migration', {
    kind: 'customization',
    files: { tests: m('tests/market-host-lifecycle.spec.ts') },
    apply: ({ tests }) => ({ tests: awaitProductSourceMigrationInLifecycleTest(tests) }),
    why: '生命周期用例等待产品来源迁移完成后再断言。',
    retireWhen: '随 market.pin-source 一起移除。',
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
]

/** 本模块不修改 staging 的脚本。 */
export const checks = [
  { file: 'market-catalog-verify.mjs', runBy: 'repo-layout-verify.mjs（产品输入检查自动调用）' },
  { file: 'market-live-regression.mjs', runBy: '手动：联网验证公开目录、归档与真实安装' },
  { file: 'market-private-install-regression.mjs', runBy: '手动：本地夹具验证私有安装与撤权' },
  { file: 'market-agent-cli-regression.mjs', runBy: '手动：原生 CLI 的私有包路由限制' },
]
