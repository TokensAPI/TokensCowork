// Product navigation and inventory badges; native layouts stay intact.
function replace(source, anchor, value) {
  if (source.split(anchor).length !== 2) throw new Error('market-home: upstream anchor changed: ' + anchor)
  return source.replace(anchor, value)
}

/** 多行锚点按测试文本里的 LF 拼，不受本文件换行风格影响。 */
const lines = (...parts) => parts.join('\n')

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
            installations={installations}
            inventoryError={installationsError}
            onRetryInventory={() => { void loadInstallations() }}`)
  const discoverStart = settingsTab.indexOf('function DiscoverView(')
  const discoverEnd = settingsTab.indexOf('\nfunction InstallableView(', discoverStart)
  let discover = settingsTab.slice(discoverStart, discoverEnd)
  discover = replace(discover, '  items: readonly VisibleItem[]', `  items: readonly VisibleItem[]
  installations: readonly MarketInstallationView[]
  inventoryError?: string | undefined
  onRetryInventory: () => void`)
  discover = replace(discover, '      {props.partialFailure &&', `      {props.inventoryError !== undefined && <div className="dshMarketBanner" role="alert">
        <StateDot state="warning" /><span>{props.inventoryError}</span>
        <Button variant="outline" size="sm" onClick={props.onRetryInventory}>{props.t('retry')}</Button>
      </div>}
      {props.partialFailure &&`)
  discover = replace(discover, 'value={value} onClick={() => props.onSelect(value)}',
    'value={value} installation={matchingInstallation(value, props.installations)} onClick={() => props.onSelect(value)}')
  settingsTab = settingsTab.slice(0, discoverStart) + discover + settingsTab.slice(discoverEnd)
  const cardStart = settingsTab.indexOf('function PluginCard(')
  const cardEnd = settingsTab.indexOf('\nfunction SourceAttribution(', cardStart)
  let card = settingsTab.slice(cardStart, cardEnd)
  card = replace(card, 'value, actionLabel, disabled', 'value, installation, actionLabel, disabled')
  card = replace(card, '  value: VisibleItem', '  value: VisibleItem\n  installation?: MarketInstallationView | undefined')
  card = replace(card, '      className="dshMarketCard"',
    '      className="dshMarketCard"\n      data-installed={installation !== undefined ? "true" : undefined}')
  card = replace(card, '        {actionLabel !== undefined &&',
    `        {installation !== undefined && <Pill className="dshMarketInstalledBadge">{t('installed')}</Pill>}
        {actionLabel !== undefined &&`)
  settingsTab = settingsTab.slice(0, cardStart) + card + settingsTab.slice(cardEnd)
  // 「已安装」的说明文案 2.0.18 起由上游自己写清了启用/停用/卸载与官方插件页的分工，
  // 产品不再改写；只补一句把空列表指回默认的发现页。
  for (const [old, next] of [
    ['当前配置中没有可显示的插件。', '当前配置中没有可显示的插件。前往“发现”查找新插件。'],
    ['There are no plugins to show in the active profile.', 'There are no plugins to show in the active profile. Use Discover to find new plugins.'],
  ]) locales = replace(locales, old, next)
  return { settingsTab, locales }
}

export function addMarketHomeStyles(styles) {
  // Gray the whole installed card without changing layout or disabling it.
  return replace(styles.replaceAll('\r\n', '\n'), '.dshMarketCard:hover {', `.dshMarketCard[data-installed="true"] {
  filter: grayscale(1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, var(--dsw-alias-bg-layer-3));
}

.dshMarketCard[data-installed="true"]:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, var(--dsw-alias-bg-layer-3));
}

.dshMarketInstalledBadge {
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2);
}

.dshMarketCard:hover {`)
}

export function adaptMarketHomeTestSetup(setup) {
  // The real static Pill forwards className; preserve that contract in its mock.
  return replace(setup.replaceAll('\r\n', '\n'),
    'props.onClick === undefined ? <span>{children}</span>',
    'props.onClick === undefined ? <span className={props.className}>{children}</span>')
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
  // 发现页挂载会先读一次清单给卡片置灰，进入 Installed 还会再做一次更新检查，
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
