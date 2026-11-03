// Product navigation and the card's installed-state mark; native layouts stay intact.
function replace(source, anchor, value) {
  if (source.split(anchor).length !== 2) throw new Error('market-home: upstream anchor changed: ' + anchor)
  return source.replace(anchor, value)
}

/** 多行锚点按测试文本里的 LF 拼，不受本文件换行风格影响。 */
const lines = (...parts) => parts.join('\n')

/** 从 `function <name>(` 切到下一个顶层函数，交给 edit 改写后拼回。 */
function editFunction(source, name, edit) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf('\nfunction ', start + 1)
  if (start < 0 || end < 0) throw new Error(`market-home: ${name} boundary changed`)
  return source.slice(0, start) + edit(source.slice(start, end)) + source.slice(end)
}

export function addMarketHome({ settingsTab, locales }) {
  settingsTab = settingsTab.replaceAll('\r\n', '\n')
  locales = locales.replaceAll('\r\n', '\n')
  settingsTab = replace(settingsTab, "initialView = 'installable'", "initialView = 'discover'")
  settingsTab = replace(settingsTab,
    `          <Pill active={view === 'installable'} aria-pressed={view === 'installable'} onClick={() => selectMarketView('installable')}>
            <IconDownloadOutlineRegular size={14} /><span>{t('installable')}</span>
          </Pill>
`, '')
  // Inventory never blocks catalog discovery and never comes from catalog metadata.
  // 安装/卸载之后的刷新由上游自己做了（installed 视图或已缓存清单都会重读），
  // 发现页因为这个 effect 读过一次清单，所以同样落在上游那个条件里。
  settingsTab = replace(settingsTab, '  const items = useMemo(', `  useEffect(() => {
    if (view === 'discover') void loadInstallations()
  }, [view, loadInstallations])

  const items = useMemo(`)
  settingsTab = replace(settingsTab,
    "      <p>{props.t('desktopUnavailable')}</p>\n    </div>\n  )\n  if (!props.loaded && props.loading)",
    `      <p>{props.t('desktopUnavailable')}</p>
      <Button variant="outline" onClick={props.onRetry}>{props.t('retry')}</Button>
    </div>
  )
  if (!props.loaded && props.loading)`)
  settingsTab = replace(settingsTab, '            items={items}', `            items={items}
            inventoryReady={installationsLoaded}
            installations={installations}
            inventoryError={installationsError}
            onRetryInventory={() => { void loadInstallations() }}`)
  settingsTab = editFunction(settingsTab, 'DiscoverView', discover => {
    discover = replace(discover, '  items: readonly VisibleItem[]', `  items: readonly VisibleItem[]
  inventoryReady: boolean
  installations: readonly MarketInstallationView[]
  inventoryError?: string | undefined
  onRetryInventory: () => void`)
    discover = replace(discover, '      {props.partialFailure &&', `      {props.inventoryError !== undefined && <div className="dshMarketBanner" role="alert">
        <StateDot state="warning" /><span>{props.inventoryError}</span>
        <Button variant="outline" size="sm" onClick={props.onRetryInventory}>{props.t('retry')}</Button>
      </div>}
      {props.partialFailure &&`)
    return replace(discover, 'value={value} onClick={() => props.onSelect(value)}',
      'value={value} installed={props.inventoryReady ? matchingInstallation(value, props.installations) ?? false : undefined} onClick={() => props.onSelect(value)}')
  })
  // 卡片右上角的状态标记（T0063）：只是卡片按钮里的图形，点它和点卡片一样打开原来的
  // 详情，安装、卸载与确认都留在详情里。清单还没读到时 installed 为 undefined，卡片
  // 不带状态、不画标记；未安装 →「+」（强调），已安装 →「✓」（低调）并让整卡略深一档。
  // 不可卸载的内置组件按已安装上底色，但不画标记。
  settingsTab = editFunction(settingsTab, 'PluginCard', card => {
    card = replace(card, 'value, actionLabel, disabled', 'value, installed, actionLabel, disabled')
    card = replace(card, '  value: VisibleItem', '  value: VisibleItem\n  installed?: MarketInstallationView | false | undefined')
    card = replace(card, '      className="dshMarketCard"\n', `      className="dshMarketCard"
      data-state={installed === undefined ? undefined : installed === false ? 'install' : 'installed'}
`)
    return replace(card, '<span>{publisher}</span></div>\n', `<span>{publisher}</span></div>
        {installed === false && <span className="dshMarketCardMark" aria-hidden="true" data-mark="install"><IconPlusOutlineRegular /></span>}
        {installed !== undefined && installed !== false && installed.removable && (
          <span className="dshMarketCardMark" aria-hidden="true" data-mark="installed"><IconCheckOutlineRegular /></span>
        )}
`)
  })
  // 「已安装」的说明文案 2.0.18 起由上游自己写清了启用/停用/卸载与官方插件页的分工，
  // 产品不再改写；只补一句把空列表指回默认的发现页。
  for (const [old, next] of [
    ['当前配置中没有可显示的插件。', '当前配置中没有可显示的插件。前往“发现”查找新插件。'],
    ['There are no plugins to show in the active profile.', 'There are no plugins to show in the active profile. Use Discover to find new plugins.'],
  ]) locales = replace(locales, old, next)
  return { settingsTab, locales }
}

export function addMarketHomeStyles(styles) {
  // 全部用宿主 token，深浅主题随之切换：「+」用宿主唯一的绿色（state-success，宿主的
  // business 强调色是蓝），加粗并套一圈圆形描边；「✓」用三级文字色、无描边。已安装卡片
  // 在原卡片底色上叠一层宿主的 hover 淡色，悬停再叠深一档的 active 色；不改透明度、
  // 不改光标，所以不会像禁用。
  return replace(styles.replaceAll('\r\n', '\n'), '.dshMarketCard:hover {', `.dshMarketCardMark {
  display: inline-flex;
  flex: none;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: auto;
  border-radius: 50%;
  corner-shape: round;
}

.dshMarketCardMark[data-mark='install'] {
  border: 1.5px solid var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

.dshMarketCardMark[data-mark='install'] svg {
  stroke-width: 2;
}

.dshMarketCardMark[data-mark='installed'] {
  color: var(--dsw-alias-label-tertiary);
}

.dshMarketCard[data-state='installed'] {
  background: linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover)), var(--dsw-alias-bg-layer-3);
}

.dshMarketCard[data-state='installed']:hover {
  background: linear-gradient(var(--dsw-alias-interactive-bg-active), var(--dsw-alias-interactive-bg-active)), var(--dsw-alias-bg-layer-3);
}

.dshMarketCard:hover {`)
}

/** 插件页「发现」标签渲染的组件；和侧栏底部的市场面板走同一个 MarketSurface。 */
const pluginsTabComponent = `
export type MarketPluginsTabProps = PropsRuntime<'plugins.tab'>
  & PropsLocale<'community-market'>
  & { readonly readLocale: () => string }

/**
 * 产品覆盖：侧栏「插件」页的「发现」标签。
 *
 * 和侧栏底部「插件市场」面板用同一个 MarketSurface：目录来自产品固定的私有源，
 * 安装、详情与更新都走市场自己的流程，不使用插件页 owner 的 install —— 那条路把
 * \`名称@版本\` 直接交给官方插件管理器，绕过产品的私有 Registry 鉴权与兼容性检查。
 * 面板自己的视图栏不渲染：这一页的标签栏（「已安装 / 发现」）已经是同一件事，
 * 嵌一排「发现 / 已安装 / 来源」只会出现两个「已安装」。
 */
export function MarketPluginsTab({ readLocale, t }: MarketPluginsTabProps) {
  return <MarketSurface initialView="discover" readLocale={readLocale} showHeader={false} showViewBar={false} t={t} />
}
`

/** 插件页「发现」标签的注册；上游插件页声明的 plugins.tab 是 list / root。 */
const pluginsTabRegistration = `  // 产品覆盖：插件页的「发现」标签指向产品市场自己的发现页。上游官方「自定义
  // 插件市场」bundle 提供的同名标签要用户自己添加索引源，产品已固定关掉它
  // （market.desktop-official-market-off），这一格由产品市场接上。
  ctx.slots.inject('plugins.tab', () => ctx.slots.register({
    name: 'plugins.tab',
    id: 'discover',
    order: 10,
    label: () => ctx.locale.bind(NS)('discover'),
    locale: NS,
    inject: () => ({ readLocale }),
  }, MarketPluginsTab))
`

/**
 * 侧栏「插件」页的「发现」标签由产品市场提供。
 *
 * 三处改动：(1) MarketSurface 增加 showViewBar，嵌进插件页时不渲染自己的视图栏；
 * (2) 新增 MarketPluginsTab，把发现页接到插件页的标签位；(3) 客户端入口注册
 * `plugins.tab` 并就地声明这个 Slot —— 它由 `@deepseek-ai/dsh-client-ui-plugin-manager`
 * 的插件页声明，而市场包并不依赖那个包（为一个标签去加依赖不值得），所以照它的
 * `client/slot-contract.d.ts` 把 kind / scope / owner 抄在这里；owner 的两个动作产品
 * 都不用，但声明出来，用例才能断言安装没有走插件页的安装对话框。这份抄件会随上游漂移，
 * 因此登记表给这条覆盖的 upstream 带上 dsh，DSH 升级时一并复查。
 * @param input - staging 副本中市场客户端入口与设置面板的内容。
 * @returns 改写后的两个文件内容。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function addMarketPluginsTab({ clientIndex, settingsTab }) {
  clientIndex = clientIndex.replaceAll('\r\n', '\n')
  settingsTab = settingsTab.replaceAll('\r\n', '\n')
  settingsTab = replace(settingsTab, '  readonly showHeader?: boolean',
    '  readonly showHeader?: boolean\n  readonly showViewBar?: boolean')
  settingsTab = replace(settingsTab, ', showHeader = true }: MarketSurfaceProps) {',
    ', showHeader = true, showViewBar = true }: MarketSurfaceProps) {')
  settingsTab = replace(settingsTab, '      <div className="dshMarketViewBar">',
    '      {showViewBar && (<div className="dshMarketViewBar">')
  settingsTab = replace(settingsTab, '      </div>\n      <main className="dshMarketMain">',
    '      </div>)}\n      <main className="dshMarketMain">')
  settingsTab = replace(settingsTab, '\nfunction DiscoverView(', `${pluginsTabComponent}\nfunction DiscoverView(`)
  clientIndex = replace(clientIndex, `declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'community-market': MarketLocaleKey
  }
}`, `declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'community-market': MarketLocaleKey
  }
  // 产品覆盖：插件页的 plugins.tab 由 @deepseek-ai/dsh-client-ui-plugin-manager 声明，
  // 市场包不依赖那个包，所以照它的 client/slot-contract.d.ts 就地声明这一格。
  // owner 的两个动作产品都不用，但声明出来，用例才能断言「没走插件页的安装对话框」。
  interface SlotMap {
    'plugins.tab': {
      kind: 'list'
      scope: 'root'
      owner: {
        /** 把 \`名称@版本\` 交给插件页自己的安装对话框；绕过产品的私有 Registry 鉴权与兼容性检查。 */
        readonly install: (target: {
          readonly spec: string
          readonly registry?: string
          readonly title: string
          readonly version: string
        }) => void
        /** 切到「已安装」并打开某个 bundle 的详情页。 */
        readonly openPackage: (packageName: string) => void
      }
    }
  }
}`)
  clientIndex = replace(clientIndex, "import { MarketSettingsTab } from './MarketSettingsTab.js'",
    "import { MarketPluginsTab, MarketSettingsTab } from './MarketSettingsTab.js'")
  // 注册在最后：上游 tests/client-api.spec.ts 按注册次序断言，排在末尾只需追加一条。
  clientIndex = replace(clientIndex, '  }, MarketOverlay))\n}', `  }, MarketOverlay))
${pluginsTabRegistration}}`)
  return { clientIndex, settingsTab }
}

/**
 * 上游市场客户端的注册用例按次序断言三条注册，产品多注册一条「发现」标签。
 *
 * 注册排在最后，所以只需把它追加进两处断言并把计数改成 4；前三条的次序与
 * `[settings, launcher, overlay]` 解构都不动。
 * @param tests - staging 副本中 tests/client-api.spec.ts 的完整内容。
 * @returns 追加第四条注册断言后的用例源码。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function expectPluginsTabInClientTest(tests) {
  tests = replace(tests.replaceAll('\r\n', '\n'),
    "  it('registers locale, styles, settings tab, sidebar launcher, and shell overlay effects', () => {",
    "  it('registers locale, styles, settings tab, sidebar launcher, shell overlay and Plugins page tab effects', () => {")
  tests = replace(tests, `      'shell.overlay',
    ])
  })`, `      'shell.overlay',
      // 产品覆盖：插件页的「发现」标签由产品市场提供。
      'plugins.tab',
    ])
  })`)
  tests = replace(tests, 'expect(test.registrations).toHaveLength(3)', 'expect(test.registrations).toHaveLength(4)')
  return replace(tests, `      expect.objectContaining({
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
      // 产品覆盖：插件页的「发现」标签，id 用上游插件页的标签 id。
      expect.objectContaining({
        name: 'plugins.tab',
        id: 'discover',
        order: 10,
        locale: NS,
      }),
    ])`)
}

export function adaptMarketHomeOverlayTests(tests) {
  tests = replace(tests.replaceAll('\r\n', '\n'), "describe('community market overlay',", `// These regressions exercise catalog requests; inventory has its own endpoint.
function withLocalInventory(request: typeof fetch): typeof fetch {
  return async (input, init) => String(input).includes('/api/community-market/installations')
    ? response({ installations: [] })
    : request(input, init)
}

describe('community market overlay',`)
  return tests.replaceAll("vi.stubGlobal('fetch', request)", "vi.stubGlobal('fetch', withLocalInventory(request))")
}

export function adaptMarketHomeTests(tests) {
  tests = tests.replaceAll('\r\n', '\n')
  tests = replace(tests, 'import { afterEach, describe,', 'import { afterEach, beforeEach, describe,')
  // 插件页「发现」标签的产品回归（market-home-ui-tests.inc）渲染同一面板的嵌入形态。
  tests = replace(tests, "import { MarketSettingsTab, type MarketSettingsTabProps } from '../src/client/MarketSettingsTab.js'",
    `import {
  MarketPluginsTab, type MarketPluginsTabProps, MarketSettingsTab, type MarketSettingsTabProps,
} from '../src/client/MarketSettingsTab.js'`)
  tests = replace(tests, 'const t = ((key:', `beforeEach(() => {
  vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
})

const t = ((key:`)
  // Keep native Installable API/explicit-view regressions even though its tab is gone.
  const legacyStart = tests.indexOf("  it('loads verified installable items by remote page")
  const legacyEnd = tests.indexOf("\n  it(", legacyStart + 1)
  if (legacyStart < 0 || legacyEnd < 0) throw new Error('market-home: legacy test boundary changed')
  let legacy = tests.slice(legacyStart, legacyEnd)
  legacy = replace(legacy, 'render(<MarketSettingsTab {...props} />)', 'render(<MarketSettingsTab {...props} initialView="installable" />)')
  legacy = replace(legacy, "    expect(await screen.findByRole('button', { name: /Browse Only/u })).toBeTruthy()\n", '')
  legacy = replace(legacy, "expect(screen.getByRole('button', { name: en.installable })).toBeTruthy()", "expect(screen.queryByRole('button', { name: en.installable })).toBeNull()")
  legacy = replace(legacy, "    fireEvent.click(screen.getByRole('button', { name: en.installable }))\n", '')
  legacy = legacy.replace('loads verified installable items by remote page', 'supports an explicit legacy Installable view with remote pages')
  tests = tests.slice(0, legacyStart) + legacy + tests.slice(legacyEnd)
  const validationStart = tests.indexOf("  it('fails closed without offering locally guessed candidates")
  const validationEnd = tests.indexOf("\n  it(", validationStart + 1)
  let validation = tests.slice(validationStart, validationEnd)
  validation = replace(validation, 'render(<MarketSettingsTab {...props} />)', 'render(<MarketSettingsTab {...props} initialView="installable" />)')
  validation = replace(validation, "    await screen.findByRole('button', { name: /Installable Plugin/u })\n    fireEvent.click(screen.getByRole('button', { name: en.installable }))\n", '')
  tests = tests.slice(0, validationStart) + validation + tests.slice(validationEnd)
  const firstStart = tests.indexOf("  it('opens on Installable by default'")
  const firstEnd = tests.indexOf("\n  it('shows a persisted first page", firstStart)
  let startup = tests.slice(firstStart, firstEnd)
  startup = startup.replaceAll("vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([]))", "vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([]))\n    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)")
  startup = startup.replaceAll("name: en.installable", "name: en.discover")
  startup = startup.replaceAll('expect(readMarketInstallable).toHaveBeenCalledOnce()', 'expect(readMarketCatalog).toHaveBeenCalledOnce()')
  startup = replace(startup, 'expect(readMarketCatalog).not.toHaveBeenCalled()', 'expect(readMarketInstallable).not.toHaveBeenCalled()')
  startup = startup.replace('opens on Installable by default', 'opens on Discover by default')
  startup = startup.replace('loads the catalog when leaving the default Installable view for Discover', 'loads the default Discover catalog')
  // Start this source-state race on Sources so navigation still triggers the race.
  const timingStart = startup.indexOf("  it.each(['pending'")
  let timing = startup.slice(timingStart)
  timing = replace(timing, "{ t, readLocale: () => 'en' } as MarketSettingsTabProps", "{ initialView: 'sources', t, readLocale: () => 'en' } as MarketSettingsTabProps")
  startup = startup.slice(0, timingStart) + timing
  tests = tests.slice(0, firstStart) + startup + tests.slice(firstEnd)
  // Installation actions now come from Discover cards, preserving the native flow.
  tests = tests.replaceAll("    fireEvent.click(screen.getByRole('button', { name: en.installable }))\n", '')
  tests = tests.replaceAll("    fireEvent.click(await screen.findByRole('button', { name: en.installable }))\n", '')
  for (const name of ['item', 'firstItem', 'secondItem']) {
    tests = tests.replaceAll('name: `${en.install}: ${' + name + '.displayName}`', 'name: new RegExp(' + name + '.displayName)')
  }
  tests = replace(tests, 'expect(readMarketInstallable).toHaveBeenCalledTimes(2)', 'expect(readMarketInstallable).not.toHaveBeenCalled()')
  // The background badge read must not consume either selection-race fixture.
  const raceStart = tests.indexOf("  it('ignores a late inventory result")
  const raceEnd = tests.indexOf("\n  it(", raceStart + 1)
  let race = tests.slice(raceStart, raceEnd)
  race = replace(race, 'vi.mocked(readMarketInstallations)\n', 'vi.mocked(readMarketInstallations)\n      .mockImplementationOnce(() => new Promise(() => {}))\n')
  tests = tests.slice(0, raceStart) + race + tests.slice(raceEnd)
  // 发现页挂载会先读一次清单给卡片的「+ / ✓」，进入 Installed 还会再做一次更新检查，
  // 上游这两个按调用次序排夹具的用例因此错位。改成跟着 Host 的当前清单走，断言
  // 只问"重新读过了"，不再钉死次数；产品里的刷新按钮现在叫"检查更新"。
  const bounds = (start, label) => {
    const from = tests.indexOf(start)
    const to = tests.indexOf(lines('', '  it('), from + 1)
    if (from < 0 || to < 0) throw new Error('market-home: upstream test boundary changed: ' + label)
    return [from, to]
  }

  const [toggleStart, toggleEnd] = bounds("  it('enables, disables, and uninstalls profile bundles", 'installed toggle')
  let toggle = tests.slice(toggleStart, toggleEnd)
  toggle = replace(toggle, lines(
    '    vi.mocked(readMarketInstallations)',
    '      .mockResolvedValueOnce({ installations: [installed, core] })',
    '      .mockResolvedValueOnce({ installations: [{ ...installed, enabled: false }, core] })',
    '      .mockResolvedValue({ installations: [core] })',
  ), lines(
    '    let inventory = [installed, core]',
    '    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))',
  ))
  toggle = replace(toggle, lines(
    '    vi.mocked(setMarketInstallationEnabled).mockResolvedValue({',
    '      packageName: installed.packageName,',
    '      enabled: false,',
    "      application: 'applied',",
    '    })',
  ), lines(
    '    vi.mocked(setMarketInstallationEnabled).mockImplementation(async () => {',
    '      inventory = [{ ...installed, enabled: false }, core]',
    "      return { packageName: installed.packageName, enabled: false, application: 'applied' }",
    '    })',
  ))
  toggle = replace(toggle, lines(
    '    vi.mocked(executeMarketOperation).mockResolvedValue({',
    "      action: 'uninstall',",
    '      packageName: installed.packageName,',
    "      application: 'applied',",
    '    })',
  ), lines(
    '    vi.mocked(executeMarketOperation).mockImplementation(async () => {',
    '      inventory = [core]',
    "      return { action: 'uninstall', packageName: installed.packageName, application: 'applied' }",
    '    })',
  ))
  // 开关状态是重新读回来的，不是乐观更新；具体次数取决于自动检查，所以只问多于一次。
  toggle = replace(toggle, '    expect(readMarketInstallations).toHaveBeenCalledTimes(2)',
    '    expect(vi.mocked(readMarketInstallations).mock.calls.length).toBeGreaterThan(1)')
  // 卸载后的重读由紧随其后的两条渲染断言覆盖，这里不再数次数。
  toggle = replace(toggle, lines('    await waitFor(() => { expect(readMarketInstallations).toHaveBeenCalledTimes(3) })', ''), '')
  tests = tests.slice(0, toggleStart) + toggle + tests.slice(toggleEnd)

  const [flakyStart, flakyEnd] = bounds("  it('shows the saved selection after a failed toggle", 'failed toggle refresh')
  let flaky = tests.slice(flakyStart, flakyEnd)
  flaky = replace(flaky, lines(
    '    vi.mocked(readMarketInstallations)',
    '      .mockResolvedValueOnce({ installations: [installed] })',
    '      .mockResolvedValue({ installations: [{ ...installed, enabled: true }] })',
  ), lines(
    '    let inventory = [installed]',
    '    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))',
  ))
  // Host 报了失败却已经把选择落盘，所以之后读回来的是启用后的状态。
  flaky = replace(flaky,
    "    vi.mocked(setMarketInstallationEnabled).mockRejectedValue(new Error('The plugin could not be enabled.'))",
    lines(
      '    vi.mocked(setMarketInstallationEnabled).mockImplementation(async () => {',
      '      inventory = [{ ...installed, enabled: true }]',
      "      throw new Error('The plugin could not be enabled.')",
      '    })',
    ))
  flaky = replace(flaky, 'name: en.refresh', 'name: en.checkUpdates')
  // 这条用例问的就是重试之后失败横幅消失，直接等横幅消失，不数读取次数。
  flaky = replace(flaky, '    await waitFor(() => { expect(readMarketInstallations).toHaveBeenCalledTimes(3) })',
    "    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })")
  tests = tests.slice(0, flakyStart) + flaky + tests.slice(flakyEnd)
  return tests
}
