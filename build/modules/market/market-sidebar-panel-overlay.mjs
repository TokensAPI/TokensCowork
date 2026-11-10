// 插件市场的侧栏入口（用户 2026-11-10 要求）：侧栏上方那一行「插件」点开就是插件市场，
// 显示在右侧主区域，内容与原来的市场浮层相同（标题 + 发现 / 已安装 / 来源）。
// 上游市场只在侧栏底部注册一个打开浮层的启动器（sidebar.footer.action）；产品去掉它，
// 改为注册一个主区域面板（main）和侧栏上方同一位置的一行（sidebar.panellist），图标沿用
// 官方插件页那一行。官方插件页那一行由 market.plugin-page-sidebar-entry 去掉，插件页本身
// 仍从设置页「前往插件页面」进入。市场浮层与设置页标签照常注册。
import { replaceOnce } from '../../pipeline/anchors.mjs'

const MARKER = '/* TokensCowork: the market opens from the sidebar Plugins row as a main panel. */'

/** 主区域面板 key 与侧栏行 id：侧栏按 id 选中同名的主面板。 */
export const MARKET_PANEL_ID = 'community-market'

const LAUNCHER_IMPORT = "import { MarketLauncher } from './MarketLauncher.js'\n"

const LAUNCHER_REGISTRATION = `  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'community-market',
    order: 10,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    store: marketView,
  }, MarketLauncher))
`

const PANEL_REGISTRATIONS = `  ${MARKER}
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: MARKET_PANEL_ID,
    locale: NS,
    inject: () => ({ readLocale }),
  }, MarketPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: MARKET_PANEL_ID,
    order: 0,
    label: () => ctx.locale.bind(NS)('sidebarEntry'),
    locale: NS,
  }, MarketPanelIcon))
`

/** 主区域页面与侧栏行图标；页面就是原来浮层的标题加同一个 MarketSurface，只是不再是弹窗。 */
const PAGE_COMPONENTS = `
export type MarketPageProps = PropsRuntime<'main'>
  & PropsLocale<'community-market'>
  & { readLocale: () => string }

/** 产品覆盖：侧栏上方「插件」打开的主区域页面，内容与市场浮层相同。 */
export function MarketPage({ readLocale, t }: MarketPageProps) {
  return (
    <div className="dshMarketPage">
      <section className="dshMarketPagePanel" aria-label={t('title')}>
        <header className="dshMarketOverlayHeader">
          <div>
            <h1>{t('title')}</h1>
            <p>{t('subtitle')}</p>
          </div>
        </header>
        <MarketSurface readLocale={readLocale} showHeader={false} t={t} />
      </section>
    </div>
  )
}

/** 产品覆盖：侧栏行图标，沿用官方插件页那一行的图标。 */
export function MarketPanelIcon({ size }: { readonly size: number }) {
  return <IconPluginPinwheelOutlineRegular size={size} />
}
`

const PAGE_STYLES = `.dshMarketPage {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 40px 32px;
}

.dshMarketPagePanel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1180px;
  margin: 0 auto;
}

`

const ENTRY_LABEL = { zh: '插件', en: 'Plugins' }

/**
 * 市场客户端改为从侧栏上方进入：去掉底部启动器，注册主区域面板与侧栏行。
 * @param input - staging 中市场客户端入口、浮层组件、样式与文案。
 * @returns 改写后的四个文件内容。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function moveMarketToSidebarPanel({ clientIndex, overlay, styles, locales }) {
  ;[clientIndex, overlay, styles, locales] = [clientIndex, overlay, styles, locales].map(text => text.replaceAll('\r\n', '\n'))
  if (clientIndex.includes(MARKER)) {
    if (clientIndex.includes("'sidebar.footer.action'") || !overlay.includes('export function MarketPage(')) {
      throw new Error('incomplete market sidebar panel overlay')
    }
    return { clientIndex, overlay, styles, locales }
  }
  const label = 'market sidebar panel'
  clientIndex = replaceOnce(clientIndex, LAUNCHER_IMPORT, '', label)
  clientIndex = replaceOnce(clientIndex, "import { MarketOverlay } from './MarketOverlay.js'\n",
    "import { MarketOverlay, MarketPage, MarketPanelIcon } from './MarketOverlay.js'\n", label)
  clientIndex = replaceOnce(clientIndex, "export const NS = 'community-market'\n",
    `export const NS = 'community-market'\n/** 产品覆盖：主区域面板 key 与侧栏行 id。 */\nconst MARKET_PANEL_ID = '${MARKET_PANEL_ID}' as MainPanelId\n`, label)
  clientIndex = replaceOnce(clientIndex, "import type {} from '@deepseek-ai/dsh-client-ui-layout/client'\n",
    "import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'\n", label)
  clientIndex = replaceOnce(clientIndex, LAUNCHER_REGISTRATION, '', label)
  // 新注册排在最后：上游 tests/client-api.spec.ts 按注册次序断言，前面的次序不动。
  clientIndex = replaceOnce(clientIndex, '  }, MarketOverlay))\n', `  }, MarketOverlay))\n${PANEL_REGISTRATIONS}`, label)

  overlay = replaceOnce(overlay, '  IconCloseOutlineRegular,\n', '  IconCloseOutlineRegular,\n  IconPluginPinwheelOutlineRegular,\n', label)
  overlay = `${overlay.trimEnd()}\n${PAGE_COMPONENTS}`

  styles = replaceOnce(styles, '\n.dshMarketOverlay {\n', `\n${PAGE_STYLES}.dshMarketOverlay {\n`, label)

  for (const [language, anchor] of [['zh', "  tab: '插件市场',\n"], ['en', "  tab: 'Plugin Market',\n"]]) {
    locales = replaceOnce(locales, anchor, `${anchor}  sidebarEntry: '${ENTRY_LABEL[language]}',\n`, label)
  }
  return { clientIndex, overlay, styles, locales }
}

/**
 * 上游 browser-plugin 用例断言三格都有注册。启动器那一格改为断言「声明了也不注册」，
 * 其余断言（设置标签、浮层、文案、不发请求、卸载清空）原样保留。
 */
export function expectNoLauncherInBrowserPluginTest(tests) {
  tests = tests.replaceAll('\r\n', '\n')
  const swaps = [
    ["  it('registers one shared Market surface in official settings and sidebar slots without fetching', () => {",
      "  it('registers one shared Market surface in official settings without a footer launcher and without fetching', () => {"],
    ['    expect(launcher).toHaveLength(1)\n',
      '    // 产品覆盖：侧栏底部不放「插件市场」启动器，市场从侧栏上方的「插件」进入。\n    expect(launcher).toHaveLength(0)\n'],
    ['    expect(launcher[0]?.component).toBe(MarketLauncher)\n', ''],
    ["    expect(launcher[0]?.options).toMatchObject({ id: 'community-market', order: 10 })\n", ''],
    ['    expect(launcher[0]?.options.store).toBe(overlay[0]?.options.store)\n', ''],
    ['    expect(launcher[0]?.locale).toBe(NS)\n', ''],
    ['    expect((launcher[0]?.options.label as () => string)()).toBe(zh.tab)\n', ''],
    ['    expect((launcher[0]?.options.label as () => string)()).toBe(en.tab)\n', ''],
    ["  it('follows late declaration and declaration reload for all three entries', () => {",
      "  it('follows late declaration and declaration reload for both entries', () => {"],
    ["    const names = ['settings.plugins.tab', 'sidebar.footer.action', 'shell.overlay'] as const",
      "    // 产品覆盖：不注册侧栏底部启动器。\n    const names = ['settings.plugins.tab', 'shell.overlay'] as const"],
    ["    expect(b.entries('sidebar.footer.action')[0]?.component).toBe(MarketLauncher)\n", ''],
  ]
  for (const [from, to] of swaps) tests = replaceOnce(tests, from, to, 'market browser-plugin test')
  // MarketLauncher 不再被断言；导入留着会让 tsc 的未使用检查报错，一并去掉。
  return replaceOnce(tests, "import { MarketLauncher } from '../src/client/MarketLauncher.js'\n", '', 'market browser-plugin test')
}

/** 上游注册用例按次序断言市场客户端的三条 Slot 注册；去掉底部启动器，末尾追加主区域面板与侧栏行。 */
export function expectSidebarPanelInClientTest(tests) {
  tests = tests.replaceAll('\r\n', '\n')
  const swaps = [
    ["  it('registers locale, styles, settings tab, sidebar launcher, and shell overlay effects', () => {",
      "  it('registers locale, styles, settings tab, shell overlay, market page and sidebar row effects', () => {"],
    ["      'settings.plugins.tab',\n      'sidebar.footer.action',\n      'shell.overlay',\n",
      "      'settings.plugins.tab',\n      'shell.overlay',\n      // 产品覆盖：不注册底部启动器，改为主区域面板与侧栏上方的一行。\n      'main',\n      'sidebar.panellist',\n"],
    ['expect(test.registrations).toHaveLength(3)', 'expect(test.registrations).toHaveLength(4)'],
    [`      expect.objectContaining({
        name: 'sidebar.footer.action',
        id: 'community-market',
        order: 10,
        locale: NS,
      }),
`, ''],
    [`      expect.objectContaining({
        name: 'shell.overlay',
        id: 'community-market',
        order: 10,
        locale: NS,
      }),
    ])`, `      expect.objectContaining({
        name: 'shell.overlay',
        id: 'community-market',
        order: 10,
        locale: NS,
      }),
      // 产品覆盖：主区域面板与侧栏行用同一个 id，侧栏按它选中面板。
      expect.objectContaining({ name: 'main', key: '${MARKET_PANEL_ID}', locale: NS }),
      expect.objectContaining({ name: 'sidebar.panellist', id: '${MARKET_PANEL_ID}', order: 0, locale: NS }),
    ])`],
    ['    const [settings, launcher, overlay] = test.registrations.map(value => value.spec)',
      '    const [settings, overlay] = test.registrations.map(value => value.spec)'],
    ["    expect(typeof launcher?.label).toBe('function')\n    expect(launcher?.store).toBe(overlay?.store)\n", ''],
  ]
  for (const [from, to] of swaps) tests = replaceOnce(tests, from, to, 'market client registration test')
  return tests
}
