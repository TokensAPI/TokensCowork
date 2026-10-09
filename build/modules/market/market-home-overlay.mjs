// Product navigation and inventory badges; native layouts stay intact.
function replace(source, anchor, value) {
  if (source.split(anchor).length !== 2) throw new Error('market-home: upstream anchor changed: ' + anchor)
  return source.replace(anchor, value)
}

export function addMarketHome({ settingsTab, locales }) {
  settingsTab = settingsTab.replaceAll('\r\n', '\n')
  locales = locales.replaceAll('\r\n', '\n')
  settingsTab = replace(settingsTab, "initialView = 'installable'", "initialView = 'discover'")
  settingsTab = replace(settingsTab,
    `          <Pill active={view === 'installable'} aria-pressed={view === 'installable'} onClick={() => selectMarketView('installable')}>
            <IconDownloadOutline16 size={14} /><span>{t('installable')}</span>
          </Pill>
`, '')
  // Inventory never blocks catalog discovery and never comes from catalog metadata.
  settingsTab = replace(settingsTab, '  const items = useMemo(', `  useEffect(() => {
    if (view === 'discover') void loadInstallations(false)
  }, [view, loadInstallations])

  const items = useMemo(`)
  settingsTab = replace(settingsTab,
    "      if (result.action === 'uninstall' && viewRef.current === 'installed') {\n        void loadInstallations()\n      }",
    "      if (result.action !== 'update') void loadInstallations()")
  settingsTab = replace(settingsTab, '            installations={installations}',
    "            installations={installations.filter(item => item.action === 'uninstall')}")
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
            onRetryInventory={() => { void loadInstallations(false) }}`)
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
  for (const [old, next] of [
    ['这里显示当前 Profile 的直接插件依赖，包括通过其他插件市场或命令行安装的插件。可卸载的插件只提供卸载操作。', '这里显示已安装的可选插件，可检查更新或卸载。内置组件不在此列表中。'],
    ['Direct plugin dependencies in the active Profile appear here, including plugins installed by other markets or the CLI. Removable plugins offer uninstall only.', 'Installed optional plugins appear here. Check for updates or uninstall them. Built-in components are excluded.'],
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
  tests = replace(tests, 'expect(readMarketInstallations).toHaveBeenCalledOnce()\n      expect(readMarketState)', 'expect(readMarketInstallations).toHaveBeenCalledTimes(2)\n      expect(readMarketState)')
  // The background badge read must not consume either selection-race fixture.
  const raceStart = tests.indexOf("  it('ignores a late inventory result")
  const raceEnd = tests.indexOf("\n  it(", raceStart + 1)
  let race = tests.slice(raceStart, raceEnd)
  race = replace(race, 'vi.mocked(readMarketInstallations)\n', 'vi.mocked(readMarketInstallations)\n      .mockImplementationOnce(() => new Promise(() => {}))\n')
  tests = tests.slice(0, raceStart) + race + tests.slice(raceEnd)
  tests = replace(tests, `    const pluginCard = screen.getByRole('heading', { name: '@tokensapi/tool' }).closest('.dshMarketReceipt')
    const coreCard = screen.getByRole('heading', { name: 'dsh-plugin-desktop' }).closest('.dshMarketReceipt')
    expect(pluginCard?.parentElement).toBe(coreCard?.parentElement)
    expect(document.querySelectorAll('.dshMarketReceipts')).toHaveLength(1)`,
    `    const pluginCard = screen.getByRole('heading', { name: '@tokensapi/tool' }).closest('.dshMarketReceipt')
    expect(pluginCard?.parentElement?.className).toBe('dshMarketReceipts')
    expect(screen.queryByRole('heading', { name: 'dsh-plugin-desktop' })).toBeNull()`)
  return tests
}
