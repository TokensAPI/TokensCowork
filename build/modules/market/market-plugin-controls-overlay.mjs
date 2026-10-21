// Desktop 2.0.18 侧栏「插件」页的市场区（dsh-plugin-desktop/src/client）。
// 上游这一页把 community-market 与 dsh-market 两张卡、「来源配置」弹窗和
// 「启用插件市场」开关无条件露出来；产品只有一个固定市场（market.pin-source /
// market.desktop-provider），所以这里收敛成一张只读的产品市场卡。
import { replaceOnce, replacePatternOnce, requireOnce } from '../../pipeline/anchors.mjs'

const MARKER = '/* TokensCowork: 插件页只提供产品自己的插件市场。 */'

/** 产品市场卡与区块说明的中英文案；上游 marketIntro 是「选择一个插件市场」，已不适用。 */
const copy = productName => `${MARKER}
// 产品固定一个插件市场，这一页不做选择、不配置来源、也不允许关闭，因此文案
// 就地给出，不走 desktop-settings-locales（那里的 marketIntro 写的是「选择一个」）。
const PRODUCT_MARKET_COPY = {
  zh: {
    title: '${productName} 插件市场',
    intro: '插件只从 ${productName} 插件市场安装，不能切换到其他市场。',
    body: '由 ${productName} 维护的插件目录，插件在这里安装和更新。',
  },
  en: {
    title: '${productName} Plugin Market',
    intro: 'Plugins install only from the ${productName} plugin market; it cannot be switched.',
    body: 'The plugin catalog maintained by ${productName}. Install and update plugins here.',
  },
} as const
`

/**
 * 插件页的市场区收敛为产品市场一张卡。
 *
 * 四处改动，缺一不可：(1) 只渲染产品市场卡，不渲染 dsh-market，也不再用上游
 * 的 marketTitle/marketBody（它们把卡片标题包成指向上游仓库的外链）；
 * (2) 去掉「来源配置」按钮——产品来源由 market.pin-source 固定，弹窗里能配的
 * 是 dshmarket / dshfind / deepseek1024 这些非产品源和官方「自定义插件市场」，
 * 对产品只有误导；(3) 去掉「启用插件市场」开关——关掉之后
 * market.desktop-provider 下次启动又会改回来，用户看到的是「关不掉」；
 * (4) 删掉随之失去入口的 MarketSourcesButton / MarketSourcesDialog 与它们专用的
 * 两个辅助函数，否则 noUnusedLocals 会让 staging 的 tsc 失败。
 *
 * 上游对 preferredMarket 的记账（缓存、effect、change()）保持原样：少改一处就少一处
 * 升级时要重新落点的锚点，产品这边它恒为 community-market。
 * @param source - staging 副本中 client/plugin-controls.tsx 的完整内容。
 * @param productName - product.json 的 product.name。
 * @returns 改写后的源码。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function pinProductMarketOnPluginPage(source, productName) {
  if (source.includes(MARKER)) {
    requireOnce(source, 'PRODUCT_MARKET_COPY = {', '插件页市场区')
    return source
  }
  let next = replaceOnce(source,
    `import {
  Button, IconWarningOutlineRegular, Modal, PluginArtworkDefault, StateDot, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Choice, MARKET_OPTIONS, marketBody, marketTitle } from './DesktopSettingsSection.tsx'`,
    `import { Button, PluginArtworkDefault, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Choice } from './DesktopSettingsSection.tsx'`,
    '插件页 primitives 与设置页导入')
  next = replaceOnce(next,
    `import {
  BUILT_IN_MARKET_SOURCES, COMMUNITY_MARKET as COMMUNITY, configureSingleMarketToOfficial, DSH_MARKET as MARKET,
  importMarketSourcesToOfficial, marketToggleTargets, OFFICIAL_CONFIGURABLE_MARKET_SOURCES, OFFICIAL_MARKET,
  REMOTE_CONTROL_BUNDLE, removeMarketSourcesFromOfficial, resolveActiveMarketSource, toggleMarketEndpointInOfficial,
  type BuiltInMarketKey, type MarketName, type MarketRuntimeState,
} from './market-toggle.ts'`,
    `import {
  COMMUNITY_MARKET as COMMUNITY, DSH_MARKET as MARKET, REMOTE_CONTROL_BUNDLE, type MarketName,
} from './market-toggle.ts'`,
    '插件页 market-toggle 导入')
  // 只有来源弹窗读社区市场的来源清单；连同产品文案一起替换掉。
  next = replacePatternOnce(next,
    /async function readCommunityMarketSources\(signal\?: AbortSignal\)[\s\S]*?\n\}\n/u,
    copy(productName),
    '插件页社区来源读取')
  // preferredMarket 只被来源弹窗和开关读；记账照旧，读取位置留空。
  next = replaceOnce(next,
    'const [preferredMarket, setPreferredMarket] = useState<MarketName>(() => cache.preferredMarket)',
    'const [, setPreferredMarket] = useState<MarketName>(() => cache.preferredMarket)',
    '插件页 preferredMarket 状态')
  next = replaceOnce(next,
    `  const bothMarkets = community?.enabled === true && market?.enabled === true
  const locked = (row?: BundleInfo): boolean => loading || busy || !row || row.readOnlyReason !== undefined || row.error !== undefined
  const activeMarkets = [community, market].flatMap(row => row?.enabled === true ? [row] : [])
  const marketToggleLocked = loading || busy || marketToggleTargets(bundles, preferredMarket, activeMarkets.length === 0).length === 0
`,
    `  const locked = (row?: BundleInfo): boolean => loading || busy || !row || row.readOnlyReason !== undefined || row.error !== undefined
  const productMarket = PRODUCT_MARKET_COPY[zh ? 'zh' : 'en']
`,
    '插件页市场开关状态')
  next = replaceOnce(next,
    `        <div><h3 id="next-market-title">{desktopText('marketTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{desktopText('marketIntro')}</p></div>
        <div className="dshNextPluginActions">
          <MarketSourcesButton context={context} bundles={bundles} preferredMarket={preferredMarket} zh={zh}
            disabled={loading || busy} onChanged={() => {
              refresh(value => value + 1)
            }} />
          <Switch label={t('启用插件市场', 'Enable plugin market')} checked={activeMarkets.length > 0}
            disabled={marketToggleLocked} onChange={enabled => {
              void change(marketToggleTargets(bundles, preferredMarket, enabled), enabled)
            }} />
        </div>
      </div>
      <div className="dshNextMarketChoices" role="radiogroup" aria-labelledby="next-market-title">
        {MARKET_OPTIONS.filter(option => option.id !== 'disabled').map(option => {
          const isCommunity = option.id === 'community-market'
          const row = isCommunity ? community : market
          return <Choice key={option.id} title={marketTitle(option, desktopText)} body={marketBody(option, desktopText)}
            badge={isCommunity ? desktopText('beta') : undefined} selected={row?.enabled === true && !bothMarkets}
            disabled={locked(row)} action={() => { void change([isCommunity ? COMMUNITY : MARKET], true) }} />
        })}
      </div>
      {bothMarkets && <p role="status" className="dshDesktopSettingsHint">{t('当前两个市场均已开启，请选择保留其中一个。', 'Both markets are currently enabled. Choose which one to keep.')}</p>}
`,
    `        <div><h3 id="next-market-title">{desktopText('marketTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{productMarket.intro}</p></div>
      </div>
      <div className="dshNextMarketChoices" role="radiogroup" aria-labelledby="next-market-title">
        <Choice title={productMarket.title} body={productMarket.body} selected={community?.enabled === true}
          disabled={locked(community)} action={() => { void change([COMMUNITY], true) }} />
      </div>
`,
    '插件页市场卡片')
  // 入口没了，弹窗和它的「发现」刷新提示也就不可达。
  next = replacePatternOnce(next,
    /\nfunction MarketSourcesButton\(\{[\s\S]*?\nconst remoteDescription/u,
    '\nconst remoteDescription',
    '插件页来源配置弹窗')
  return replacePatternOnce(next,
    /\nfunction reloadDiscoverIndexesIfMounted\(context: Context\): void \{[\s\S]*$/u,
    '\n',
    '插件页发现页刷新提示')
}

const REMOTE_MARKER = '/* TokensCowork: 远程控制卡不在插件页露出。 */'

/**
 * 插件页不渲染「远程控制」卡。
 *
 * Agents Anywhere 随包分发但产品不露出入口（侧栏那个入口早已藏掉），2.0.18 把它
 * 在插件页上做成一张带开关和「打开面板」的卡，口径又不一致了。只藏界面：bundle
 * 的启停状态与运行时行为一概不动（`plugins.bundle.hidden` 里上游已经把它挡在通用
 * 清单之外，所以藏掉这张卡之后界面上就没有它了）。
 * 卡片没了之后 PluginCard / RemoteControlSettings / remoteDescription 与
 * ReactNode、PluginArtworkDefault、Switch、REMOTE、remoteRow、onOpenBundle 全部失去
 * 引用，一并删掉，否则 staging 的 tsc（noUnusedLocals / noUnusedParameters）失败。
 * `export { REMOTE_CONTROL_BUNDLE }` 保留：client/index.ts 从这里再导出它。
 * @param source - plugin-controls.tsx 的内容（已经过 pinProductMarketOnPluginPage）。
 * @returns 改写后的源码。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function hideRemoteControlCard(source) {
  if (source.includes(REMOTE_MARKER)) {
    requireOnce(source, REMOTE_MARKER, '插件页远程控制卡')
    return source
  }
  let next = replaceOnce(source,
    `import { useEffect, useRef, useState, type ReactNode } from 'react'`,
    `import { useEffect, useRef, useState } from 'react'`,
    '插件页 react 导入')
  next = replaceOnce(next,
    `import { Button, PluginArtworkDefault, Switch } from '@deepseek-ai/dsh-client-ui-primitives'`,
    `import { Button } from '@deepseek-ai/dsh-client-ui-primitives'`,
    '插件页 primitives 导入')
  // REMOTE 与 Translate 都只服务远程控制卡（组件文案里的 t 是就地推断的箭头函数）。
  next = replaceOnce(next,
    `export { REMOTE_CONTROL_BUNDLE }
const REMOTE = REMOTE_CONTROL_BUNDLE
`,
    `export { REMOTE_CONTROL_BUNDLE }
${REMOTE_MARKER}
`,
    '插件页远程控制常量')
  next = replaceOnce(next,
    `
type Translate = (cn: string, en: string) => string
`,
    '',
    '插件页 Translate 类型')
  next = replaceOnce(next,
    `  t: translate,
  onOpenBundle,
}: PropsLocale<`,
    `  t: translate,
}: PropsLocale<`,
    '插件页组件入参')
  next = replaceOnce(next,
    `  const remoteRow = bundles.find(row => row.name === REMOTE)
`,
    '',
    '插件页远程控制行')
  next = replaceOnce(next,
    `    <div className="dshNextPluginSections">
      <PluginCard title={t('远程控制', 'Remote Control')} description={remoteDescription(t)}
        icon={<PluginArtworkDefault size={36} />} onOpen={() => { onOpenBundle(REMOTE) }}>
        <RemoteControlSettings context={context} t={t} row={remoteRow} loading={loading}
          onChanged={() => { refresh(value => value + 1) }} />
      </PluginCard>
    </div>
`,
    '',
    '插件页远程控制卡')
  return replacePatternOnce(next,
    /\nconst remoteDescription = \(t: Translate\): string => t\([\s\S]*?\nfunction readOfficialBundles/u,
    '\nfunction readOfficialBundles',
    '插件页远程控制组件')
}

/** 官方「自定义插件市场」bundle 的包名（market-toggle.ts 的 OFFICIAL_MARKET）。 */
export const OFFICIAL_MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle'

/**
 * 官方「自定义插件市场」bundle 不出现在插件页。
 *
 * 它在上游的 OPTIONAL_BUNDLES / MORE_BUNDLES 里，插件页的「更多」清单从一开始
 * 就显示它，开启后会给插件页再挂一个 `plugins.tab` 的「发现」页，按用户自己添加
 * 的索引浏览安装——又是一个与产品市场并列的插件市场入口。上游已经用
 * `plugins.bundle.hidden` 把两个内置市场和远程控制挡在通用清单之外，产品把它一起挡掉。
 * 追加在数组末尾：上游用例按注册次序断言前三条，这样只需在末尾补一条断言。
 * @param source - staging 副本中 client/desktop-settings.ts 的完整内容。
 * @returns 改写后的源码。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function hideOfficialMarketBundle(source) {
  if (source.includes('OFFICIAL_MARKET')) {
    requireOnce(source, 'REMOTE_CONTROL_BUNDLE, OFFICIAL_MARKET]', '插件页隐藏官方市场')
    return source
  }
  const next = replaceOnce(source,
    `import { COMMUNITY_MARKET, DSH_MARKET, REMOTE_CONTROL_BUNDLE } from './market-toggle.ts'`,
    `import { COMMUNITY_MARKET, DSH_MARKET, OFFICIAL_MARKET, REMOTE_CONTROL_BUNDLE } from './market-toggle.ts'`,
    '插件页隐藏官方市场导入')
  return replaceOnce(next,
    `    const disposers = [COMMUNITY_MARKET, DSH_MARKET, REMOTE_CONTROL_BUNDLE].map(key =>`,
    `    // 产品覆盖：官方「自定义插件市场」也是一个插件市场入口，一起挡在清单之外。
    const disposers = [COMMUNITY_MARKET, DSH_MARKET, REMOTE_CONTROL_BUNDLE, OFFICIAL_MARKET].map(key =>`,
    '插件页隐藏官方市场清单')
}

/**
 * 上游设置页用例按注册次序断言被隐藏的 bundle，产品多挡一个，补上第四条断言。
 * @param source - staging 副本中 tests/client-desktop-settings.spec.ts 的完整内容。
 * @returns 追加断言后的用例源码。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function expectOfficialMarketHiddenInTest(source) {
  const anchor = `    expect(register).toHaveBeenNthCalledWith(5, {
      name: 'plugins.bundle.hidden',
      key: '@agents-anywhere/dsh-bridge-next',
    }, expect.any(Function))
`
  if (source.includes(OFFICIAL_MARKET_BUNDLE)) {
    requireOnce(source, 'toHaveBeenNthCalledWith(6, {', '插件页隐藏官方市场用例')
    return source
  }
  return replaceOnce(source, anchor, `${anchor}    // 产品覆盖：官方「自定义插件市场」也被挡在通用清单之外。
    expect(register).toHaveBeenNthCalledWith(6, {
      name: 'plugins.bundle.hidden',
      key: '${OFFICIAL_MARKET_BUNDLE}',
    }, expect.any(Function))
`, '插件页隐藏官方市场用例')
}
