import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AnchorError } from '../../pipeline/anchors.mjs'
import {
  expectOfficialMarketHiddenInTest, hideOfficialMarketBundle, hideRemoteControlCard, OFFICIAL_MARKET_BUNDLE,
  pinProductMarketOnPluginPage,
} from './market-plugin-controls-overlay.mjs'

const upstream = file => readFileSync(new URL(`../../../desktop/dsh-plugin-desktop/${file}`, import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n')
const read = file => upstream(`src/client/${file}`)
const controls = read('plugin-controls.tsx')
const settings = read('desktop-settings.ts')
const settingsSpec = upstream('tests/client-desktop-settings.spec.ts')
const patched = pinProductMarketOnPluginPage(controls, 'TokensCowork')
/** staging 实际得到的形态：两条同文件覆盖按登记顺序叠加。 */
const final = hideRemoteControlCard(patched)
const count = (source, text) => source.split(text).length - 1

/** 插件页市场区的 JSX：从组件的 return 到市场 section 结束。 */
const marketSection = source => {
  const start = source.indexOf('<section className="dshDesktopSettingsGroup" data-next-markets')
  assert.notEqual(start, -1, 'market section not found')
  return source.slice(start, source.indexOf('</section>', start))
}

/** 一条 import 语句里引入的名字（去掉 type 前缀与 as 别名）。 */
const imported = (source, module) => {
  const match = new RegExp(`import \\{([^{}]*)\\} from '${module.replaceAll('.', '\\.')}'`, 'u').exec(source)
  assert.ok(match, `no import from ${module}`)
  return match[1].split(',').map(item => item.trim().replace(/^type /u, ''))
    .map(item => item.includes(' as ') ? item.slice(item.indexOf(' as ') + 4) : item)
    .filter(item => item.length > 0)
}

/** 标识符作为独立词出现的次数。 */
const words = (source, name) => [...source.matchAll(new RegExp(`\\b${name}\\b`, 'gu'))].length

test('upstream really offers two market cards, the sources dialog and the market switch', () => {
  const section = marketSection(controls)
  assert.match(section, /MARKET_OPTIONS\.filter\(option => option\.id !== 'disabled'\)/u)
  assert.match(section, /<MarketSourcesButton /u)
  assert.match(section, /启用插件市场/u)
  // 两张卡共用一个 Choice：community 以外的那张就是 dsh-market。
  assert.match(section, /isCommunity \? COMMUNITY : MARKET/u)
  assert.equal(count(controls, 'function MarketSourcesDialog('), 1)
})

test('the plugin page keeps only the product market card', () => {
  const section = marketSection(patched)
  assert.equal(count(section, '<Choice '), 1)
  assert.match(section, /selected=\{community\?\.enabled === true\}/u)
  assert.match(section, /action=\{\(\) => \{ void change\(\[COMMUNITY\], true\) \}\}/u)
  // 产品市场以外没有第二个市场，也没有切过去的动作。
  assert.doesNotMatch(section, /\bMARKET\b/u)
  assert.doesNotMatch(section, /MARKET_OPTIONS/u)
})

test('the card shows the product name without the upstream repository link', () => {
  const section = marketSection(patched)
  assert.match(section, /title=\{productMarket\.title\}/u)
  assert.match(section, /body=\{productMarket\.body\}/u)
  assert.match(patched, /title: 'TokensCowork 插件市场'/u)
  assert.match(patched, /title: 'TokensCowork Plugin Market'/u)
  // marketTitle/marketBody 把标题包成指向上游仓库的 RepositoryLink。
  assert.equal(count(patched, 'marketTitle('), 0)
  assert.equal(count(patched, 'marketBody('), 0)
  // 上游 marketIntro 写的是「选择一个插件市场」，产品只有一个。
  assert.equal(count(patched, "desktopText('marketIntro')"), 0)
  assert.match(section, /\{productMarket\.intro\}/u)
})

test('neither the sources dialog nor the market switch survives, dialog code included', () => {
  for (const gone of ['MarketSourcesButton', 'MarketSourcesDialog', '来源配置', '启用插件市场',
    'marketToggleTargets', 'BUILT_IN_MARKET_SOURCES', 'OFFICIAL_CONFIGURABLE_MARKET_SOURCES', 'OFFICIAL_MARKET',
    'resolveActiveMarketSource', 'importMarketSourcesToOfficial', 'configureSingleMarketToOfficial',
    'removeMarketSourcesFromOfficial', 'toggleMarketEndpointInOfficial',
    'readCommunityMarketSources', 'reloadDiscoverIndexesIfMounted', 'bothMarkets']) {
    assert.equal(count(patched, gone), 0, `${gone} must not survive`)
  }
  // 市场区以外的上游行为保持不动（远程控制卡由下一条覆盖处理）。
  assert.equal(count(patched, 'function RemoteControlSettings('), 1)
  assert.equal(count(patched, 'function readOfficialBundles('), 1)
})

test('the Remote Control card, its switch and its open-panel button are gone', () => {
  assert.match(patched, /启用远程控制/u, 'upstream must still offer the card before the overlay')
  for (const gone of ['dshNextPluginSections', 'PluginCard', 'RemoteControlSettings', 'remoteDescription',
    'Agents Anywhere', '启用远程控制', '打开面板', 'onOpenBundle', 'remoteRow', 'const REMOTE =']) {
    assert.equal(count(final, gone), 0, `${gone} must not survive`)
  }
  // 只藏界面：bundle 名仍然再导出（client/index.ts 从这里取），启停行为不碰。
  assert.match(final, /^export \{ REMOTE_CONTROL_BUNDLE \}$/mu)
  assert.equal(count(final, 'setBundleEnabled'), 1, 'only the market card may change bundle state')
  assert.match(final, /setBundleEnabled\(name, enabled\)/u)
  // 市场卡与错误重试留在页上。
  assert.equal(count(marketSection(final), '<Choice '), 1)
  assert.match(final, /\{t\('重试', 'Retry'\)\}/u)
})

test('no import is left unused and no removed symbol is still referenced', () => {
  // staging 的 tsc 开着 noUnusedLocals / noUnusedParameters；本地没有宿主依赖，按引用计数兜住同一条约束。
  for (const module of ['@deepseek-ai/dsh-client-ui-primitives', './DesktopSettingsSection.tsx', './market-toggle.ts']) {
    for (const name of imported(final, module)) {
      assert.ok(words(final, name) > 1, `${name} imported from ${module} but never used`)
    }
  }
  assert.deepEqual(imported(final, '@deepseek-ai/dsh-client-ui-primitives'), ['Button'])
  assert.deepEqual(imported(final, './DesktopSettingsSection.tsx'), ['Choice'])
  assert.deepEqual(imported(final, './market-toggle.ts'), ['COMMUNITY', 'MARKET', 'REMOTE_CONTROL_BUNDLE', 'MarketName'])
  assert.deepEqual(imported(final, 'react'), ['useEffect', 'useRef', 'useState'])
  assert.equal(count(final, 'type Translate'), 0, 'the Translate alias only served the Remote Control card')
  // preferredMarket 的记账留着（缓存与 change() 仍写它），只有读取位置空了。
  assert.match(final, /const \[, setPreferredMarket\] = useState<MarketName>/u)
  assert.equal(count(final, 'preferredMarket={'), 0)
})

test('the official Custom Plugin Market bundle is hidden from the plugin list', () => {
  assert.equal(count(settings, 'OFFICIAL_MARKET'), 0, 'upstream must not already hide it')
  const hidden = hideOfficialMarketBundle(settings)
  assert.match(hidden, /import \{ COMMUNITY_MARKET, DSH_MARKET, OFFICIAL_MARKET, REMOTE_CONTROL_BUNDLE \} from '\.\/market-toggle\.ts'/u)
  assert.match(hidden, /\[COMMUNITY_MARKET, DSH_MARKET, REMOTE_CONTROL_BUNDLE, OFFICIAL_MARKET\]\.map\(key =>/u)
  assert.match(hidden, /name: 'plugins\.bundle\.hidden',/u)
  // 包名写死在覆盖里（上游用例断言的是字面量），上游改名要在这里报出来。
  assert.match(read('market-toggle.ts'), new RegExp(`export const OFFICIAL_MARKET = '${OFFICIAL_MARKET_BUNDLE}'`, 'u'))
})

test('the upstream hidden-bundle test gets the fourth registration appended', () => {
  // 上游按注册次序断言前三条；多挡一个就必须补第四条，否则 staging 的 Desktop 用例失败。
  assert.equal(count(settingsSpec, 'toHaveBeenNthCalledWith(5, {'), 1)
  assert.equal(count(settingsSpec, OFFICIAL_MARKET_BUNDLE), 0)
  const adapted = expectOfficialMarketHiddenInTest(settingsSpec)
  assert.match(adapted, /toHaveBeenNthCalledWith\(6, \{\n      name: 'plugins\.bundle\.hidden',\n      key: '@deepseek-ai\/dsh-experimental-plugin-market-bundle',\n    \}, expect\.any\(Function\)\)/u)
  assert.equal(expectOfficialMarketHiddenInTest(adapted), adapted)
  assert.throws(() => expectOfficialMarketHiddenInTest(settingsSpec.replace("key: '@agents-anywhere/dsh-bridge-next',", "key: REMOTE_CONTROL_BUNDLE,")), AnchorError)
})

test('all transforms are repeatable and refuse a drifted upstream', () => {
  assert.equal(pinProductMarketOnPluginPage(patched, 'TokensCowork'), patched)
  assert.equal(hideRemoteControlCard(final), final)
  for (const [from, to] of [
    ['useState, type ReactNode } from', 'useState, type ReactNode, type Key } from'],
    ['Button, PluginArtworkDefault, Switch }', 'Button, PluginArtworkDefault }'],
    ['const REMOTE = REMOTE_CONTROL_BUNDLE', 'const REMOTE_BUNDLE = REMOTE_CONTROL_BUNDLE'],
    ['type Translate = (cn: string', 'type Translate = (zh: string'],
    ['  onOpenBundle,\n', '  onOpenBundle, // moved\n'],
    ['const remoteRow = bundles.find', 'const remote = bundles.find'],
    ['<div className="dshNextPluginSections">', '<div className="dshNextPluginGroups">'],
    ['const remoteDescription = (t: Translate)', 'const remoteDescription = (translate: Translate)'],
  ]) {
    assert.ok(patched.includes(from), `fixture lost ${from}`)
    assert.throws(() => hideRemoteControlCard(patched.replace(from, to)), AnchorError, `drift in ${from} must fail the build`)
  }
  const hidden = hideOfficialMarketBundle(settings)
  assert.equal(hideOfficialMarketBundle(hidden), hidden)
  // 半成品（标记在、产品文案被删）必须报错，不能当成已应用。
  assert.throws(() => pinProductMarketOnPluginPage(patched.replace('PRODUCT_MARKET_COPY = {', 'OTHER = {'), 'TokensCowork'),
    AnchorError)
  assert.throws(() => hideOfficialMarketBundle(hidden.replace('REMOTE_CONTROL_BUNDLE, OFFICIAL_MARKET]', 'REMOTE_CONTROL_BUNDLE]')),
    AnchorError)
  for (const drift of ['MARKET_OPTIONS.filter', '启用插件市场', 'function MarketSourcesButton',
    'const bothMarkets = community', 'const [preferredMarket, setPreferredMarket]',
    'async function readCommunityMarketSources', 'function reloadDiscoverIndexesIfMounted(',
    '  Button, IconWarningOutlineRegular, Modal, PluginArtworkDefault, StateDot, Switch, Tag,']) {
    assert.throws(() => pinProductMarketOnPluginPage(controls.replace(drift, `${drift}X`), 'TokensCowork'), AnchorError,
      `drift in ${drift} must fail the build`)
  }
  assert.throws(() => hideOfficialMarketBundle(settings.replace('REMOTE_CONTROL_BUNDLE } from', 'REMOTE_CONTROL_BUNDLE, } from')), AnchorError)
})

test('the three overlays are registered against the plugin page client sources, market first', async () => {
  const { default: overlays } = await import('./overlays.mjs')
  const ids = overlays.map(item => item.id)
  const single = overlays.find(item => item.id === 'market.plugin-page-single-market')
  const remote = overlays.find(item => item.id === 'market.plugin-page-hide-remote-control')
  const hide = overlays.find(item => item.id === 'market.plugin-page-hide-official-market')
  // 同一个文件两条覆盖，远程控制那条读的是市场那条的结果。
  assert.ok(ids.indexOf('market.plugin-page-single-market') < ids.indexOf('market.plugin-page-hide-remote-control'))
  assert.equal(single.phase, 'prepare')
  assert.equal(remote.phase, 'prepare')
  assert.equal(hide.phase, 'prepare')
  assert.equal(remote.files.controls, 'dsh-plugin-desktop/src/client/plugin-controls.tsx')
  assert.deepEqual(remote.apply({ controls: patched }), { controls: final })
  assert.equal(single.files.controls, 'dsh-plugin-desktop/src/client/plugin-controls.tsx')
  assert.equal(hide.files.settings, 'dsh-plugin-desktop/src/client/desktop-settings.ts')
  assert.equal(hide.files.tests, 'dsh-plugin-desktop/tests/client-desktop-settings.spec.ts')
  assert.deepEqual(single.apply({ controls }, { product: { product: { name: 'TokensCowork' } } }), { controls: patched })
  assert.deepEqual(hide.apply({ settings, tests: settingsSpec }), {
    settings: hideOfficialMarketBundle(settings),
    tests: expectOfficialMarketHiddenInTest(settingsSpec),
  })
})
