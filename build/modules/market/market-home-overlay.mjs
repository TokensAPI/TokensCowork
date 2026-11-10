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
  // 发现页也查一次更新（market.updates 的同一个检查：本地清单先到、先画 + / ✓，
  // 版本结果后到再把有新版的卡片翻成「可更新」），用户不用切到「已安装」才知道。
  // 只在这里和发现页的重试上显式带 true：打开详情时的清单读取要等结果才决定
  // 走安装还是详情，不能被更新检查拖慢，所以默认参数不动。
  settingsTab = replace(settingsTab, '  const items = useMemo(', `  useEffect(() => {
    if (view === 'discover') void loadInstallations(true)
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
            onRetryInventory={() => { void loadInstallations(true) }}`)
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
  // 详情，安装、卸载、更新与确认都留在详情里。清单还没读到时 installed 为 undefined，卡片
  // 不带状态、不画标记；未安装 →「+」（强调），已安装 →「✓」（低调）并让整卡略深一档；
  // 已安装且更新检查报 available →「可更新」（宿主刷新图标，蓝色描边），底色同已安装。
  // 不可卸载的内置组件按已安装上底色，但不画标记（它们也不会报 available）。
  settingsTab = editFunction(settingsTab, 'PluginCard', card => {
    card = replace(card, 'value, actionLabel, disabled', 'value, installed, actionLabel, disabled')
    card = replace(card, '  value: VisibleItem', '  value: VisibleItem\n  installed?: MarketInstallationView | false | undefined')
    card = replace(card, '      className="dshMarketCard"\n', `      className="dshMarketCard"
      data-state={installed === undefined ? undefined : installed === false ? 'install' : updatable ? 'update' : 'installed'}
`)
    card = replace(card, '<span>{publisher}</span></div>\n', `<span>{publisher}</span></div>
        {installed === false && <span className="dshMarketCardMark" aria-hidden="true" data-mark="install"><IconPlusOutlineRegular /></span>}
        {updatable && <span className="dshMarketCardMark" aria-hidden="true" data-mark="update"><IconRefreshOutlineRegular /></span>}
        {installed !== undefined && installed !== false && installed.removable && !updatable && (
          <span className="dshMarketCardMark" aria-hidden="true" data-mark="installed"><IconCheckOutlineRegular /></span>
        )}
`)
    // 底部标签行最后一格写明状态（T0063 追加 2）：恢复原来的「已安装」角标（同一种
    // 上游 Pill，灰色），再补一个绿色的「可安装」与蓝色的「可更新」；文案用已有的
    // installed / installable / updateAvailable（后者来自 market.updates）。
    // 显示条件与右上角标记相同：清单未到、不可卸载的内置组件都不显示。
    card = replace(card, '        {value.item.categories?.slice(0, 2).map(category => <Pill key={category}>{category}</Pill>)}\n', `        {value.item.categories?.slice(0, 2).map(category => <Pill key={category}>{category}</Pill>)}
        {installed === false && <Pill className="dshMarketInstallableBadge">{t('installable')}</Pill>}
        {updatable && <Pill className="dshMarketUpdatableBadge">{t('updateAvailable')}</Pill>}
        {installed !== undefined && installed !== false && installed.removable && !updatable && <Pill className="dshMarketInstalledBadge">{t('installed')}</Pill>}
`)
    return replace(card, '  const publisher = value.item.publisher?.name ?? value.source.name\n',
      `  const publisher = value.item.publisher?.name ?? value.source.name
  const updatable = installed !== undefined && installed !== false && installed.removable && installed.updateStatus === 'available'
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
  // 不改光标，所以不会像禁用。底部状态标签：「已安装」恢复原角标的灰色，「可安装」用
  // 宿主成功色文字 + 成功色淡底。
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

.dshMarketCardMark[data-mark='update'] {
  border: 1.5px solid var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}

.dshMarketCardMark[data-mark='update'] svg {
  width: 14px;
  height: 14px;
}

.dshMarketTags > .dshMarketInstalledBadge,
.dshMarketTags > .dshMarketInstallableBadge,
.dshMarketTags > .dshMarketUpdatableBadge {
  flex: none;
  white-space: nowrap;
}

.dshMarketTags > .dshMarketUpdatableBadge {
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
}

.dshMarketTags > .dshMarketInstalledBadge {
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2);
}

.dshMarketTags > .dshMarketInstallableBadge {
  color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-tertiary);
}

.dshMarketCard[data-state='installed'],
.dshMarketCard[data-state='update'] {
  background: linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover)), var(--dsw-alias-bg-layer-3);
}

.dshMarketCard[data-state='installed']:hover,
.dshMarketCard[data-state='update']:hover {
  background: linear-gradient(var(--dsw-alias-interactive-bg-active), var(--dsw-alias-interactive-bg-active)), var(--dsw-alias-bg-layer-3);
}

.dshMarketCard:hover {`)
}

/** 目录元数据里的时间按本机时区与语言显示；解析失败原样显示。 */
const marketTimeHelper = `
/** 产品覆盖：服务端给的是 ISO 时间（UTC，带 Z），直接贴出来看着像差了 8 小时；按本机时区与语言显示。 */
export function formatMarketTime(value: string): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString(undefined, { hour12: false })
}
`

/**
 * 「来源」与「已安装」视图里的「目录更新于 / 缓存有效期至」改为本地时间（用户 2026-11-10）。
 * @param settingsTab - staging 中市场设置面板的内容。
 * @returns 改写后的内容。
 * @throws 上游锚点变化时抛出。
 */
export function localizeMarketTimestamps(settingsTab) {
  settingsTab = settingsTab.replaceAll('\r\n', '\n')
  const scanned = "<span>{props.t('scannedAt')}: {props.metadata.scannedAt}</span>"
  if (settingsTab.split(scanned).length !== 3) throw new Error('market-home: upstream anchor changed: ' + scanned)
  settingsTab = settingsTab.replaceAll(scanned, "<span>{props.t('scannedAt')}: {formatMarketTime(props.metadata.scannedAt)}</span>")
  settingsTab = replace(settingsTab, "<span>{props.t('cacheExpiresAt')}: {props.metadata.expiresAt}</span>",
    "<span>{props.t('cacheExpiresAt')}: {formatMarketTime(props.metadata.expiresAt)}</span>")
  return replace(settingsTab, '\nfunction DiscoverView(', `${marketTimeHelper}\nfunction DiscoverView(`)
}

/** 上游用例按原始 ISO 字符串断言这几处时间；改为断言同一时间的本地显示。 */
export function expectLocalTimestampsInTests(tests) {
  tests = tests.replaceAll('\r\n', '\n')
  for (const [label, value] of [
    ['scannedAt', 'catalogWithMetadata.metadata!.scannedAt'],
    ['cacheExpiresAt', 'catalogWithMetadata.metadata!.expiresAt'],
    ['scannedAt', 'initialIndex.metadata!.scannedAt'],
  ]) {
    tests = replace(tests, `expect(screen.getByText(\`\${en.${label}}: \${${value}}\`)).toBeTruthy()`,
      `expect(screen.getByText(\`\${en.${label}}: \${new Date(${value}).toLocaleString(undefined, { hour12: false })}\`)).toBeTruthy()`)
  }
  return tests
}

export function adaptMarketHomeTestSetup(setup) {
  // 真实的静态 Pill 会透传 className（底部状态标签靠它）；测试桩照这个契约补上。
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

  // 发现页挂载时除了本地清单还会做一次更新检查（卡片「可更新」状态），安装成功后的
  // 重读排在这两次之后：本地清单、更新检查、安装后重读，共三次。
  const [installStart, installEnd] = bounds("  it('previews an exact package and profile before install", 'install preview')
  let install = tests.slice(installStart, installEnd)
  install = replace(install, '      expect(readMarketInstallations).toHaveBeenCalledTimes(2)',
    '      expect(readMarketInstallations).toHaveBeenCalledTimes(3)')
  tests = tests.slice(0, installStart) + install + tests.slice(installEnd)
  return tests
}
