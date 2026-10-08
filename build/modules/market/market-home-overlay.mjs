// Applied after the update overlay: local inventory is the default market page.
function replace(source, anchor, value) {
  if (source.split(anchor).length !== 2) throw new Error(`market-home: upstream anchor changed: ${anchor}`)
  return source.replace(anchor, value)
}

export function addMarketHome({ settingsTab, locales }) {
  settingsTab = settingsTab.replaceAll('\r\n', '\n')
  locales = locales.replaceAll('\r\n', '\n')
  settingsTab = replace(settingsTab, "initialView = 'installable'", "initialView = 'installed'")
  settingsTab = replace(settingsTab,
    'const [installationsLoading, setInstallationsLoading] = useState(false)',
    "const [installationsLoading, setInstallationsLoading] = useState(initialView === 'installed')")
  // Invalidate any in-flight inventory/update read after a successful operation.
  // Re-read Host inventory instead of inventing an installation from catalog data.
  settingsTab = replace(settingsTab,
    "      if (result.action === 'uninstall' && viewRef.current === 'installed') {\n        void loadInstallations()\n      }",
    "      if (result.action !== 'update') void loadInstallations()")
  settingsTab = replace(settingsTab,
    "      <p>{props.t('desktopUnavailable')}</p>\n    </div>\n  )\n  if (!props.loaded && props.loading)",
    "      <p>{props.t('desktopUnavailable')}</p>\n      <Button variant=\"outline\" onClick={props.onRetry}>{props.t('retry')}</Button>\n    </div>\n  )\n  if (!props.loaded && props.loading)")
  for (const [old, next] of [
    ["这里显示当前 Profile 的直接插件依赖，包括通过其他插件市场或命令行安装的插件。可卸载的插件只提供卸载操作。", '这里显示已安装的可选插件，可检查更新或卸载。内置组件不在此列表中。'],
    ['Direct plugin dependencies in the active Profile appear here, including plugins installed by other markets or the CLI. Removable plugins offer uninstall only.', 'Installed optional plugins appear here. Check for updates or uninstall them. Built-in components are excluded.'],
    ['当前配置中没有可显示的插件。', '当前配置中没有可显示的插件。前往“可安装”或“发现”查找新插件。'],
    ['There are no plugins to show in the active profile.', 'There are no plugins to show in the active profile. Use Installable or Discover to find new plugins.'],
  ]) locales = replace(locales, old, next)
  return addMarketLists({ settingsTab, locales })
}

function addMarketLists({ settingsTab, locales }) {
  // Keep the native views and styles. Only partition the real installation inventory.
  settingsTab = replace(settingsTab, '      const response = await readMarketInstallable(readLocale(), {',
    '      const [response, inventory] = await Promise.all([readMarketInstallable(readLocale(), {')
  settingsTab = replace(settingsTab, '      }, request.signal)\n      if (request.signal.aborted || installableRequest.current !== request) return',
    '      }, request.signal), readMarketInstallations(request.signal)])\n      if (request.signal.aborted || installableRequest.current !== request) return\n      setInstallations(inventory.installations)\n      setInstallationsLoaded(true)')
  settingsTab = replace(settingsTab,
    '() => (installableIndex?.items ?? []).map(item => ({ item, source: installableIndex!.source, stale: false })),\n    [installableIndex],',
    '() => (installableIndex?.items ?? []).filter(item => !installations.some(local => local.packageName === item.package?.name)).map(item => ({ item, source: installableIndex!.source, stale: false })),\n    [installableIndex, installations],')
  settingsTab = replace(settingsTab, '            installations={installations}',
    "            installations={installations.filter(item => item.action === 'uninstall')}")
  locales = replace(locales, '这里显示当前来源中提供 npm 安装目标的插件。安装前会从 npm 获取最新稳定版并确认它是 DSH 插件。',
    '这里显示当前账号可安装但尚未安装的插件。已安装插件请前往“已安装”。')
  locales = replace(locales, 'This view shows source entries with an npm install target. Before installation, Desktop resolves npm latest and confirms that it is a DSH plugin.',
    'Plugins available to your account that are not installed appear here. Manage installed plugins under Installed.')
  return { settingsTab, locales }
}

export function adaptMarketHomeTests(tests) {
  tests = tests.replaceAll('\r\n', '\n')
  tests = replace(tests, 'import { afterEach, describe,', 'import { afterEach, beforeEach, describe,')
  tests = replace(tests, 'const t = ((key:', `beforeEach(() => {
  vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
})

const t = ((key:`)
  // Retain upstream Installable startup/race tests with an explicit view.
  tests = replace(tests, "it('opens on Installable by default'", "it('opens on Installable when explicitly requested'")
  tests = tests.replaceAll("{ t, readLocale: () => 'en' } as MarketSettingsTabProps", "{ initialView: 'installable', t, readLocale: () => 'en' } as MarketSettingsTabProps")
  tests = replace(tests,
    "expect(readMarketInstallations).toHaveBeenCalledOnce()\n      expect(readMarketState)",
    "expect(readMarketInstallations).toHaveBeenCalledTimes(3)\n      expect(readMarketState)")
  // Inventory is now resolved before Installable cards are shown. Preserve the
  // late detail-selection regression through Discover, where reads stay lazy.
  const raceStart = tests.indexOf("  it('ignores a late inventory result")
  const raceEnd = tests.indexOf("\n  it(", raceStart + 1)
  let race = tests.slice(raceStart, raceEnd)
  race = replace(race, "    fireEvent.click(await screen.findByRole('button', { name: en.installable }))\n", '')
  race = replace(race, '`${en.install}: ${firstItem.displayName}`', 'new RegExp(firstItem.displayName)')
  race = replace(race, '`${en.install}: ${secondItem.displayName}`', 'new RegExp(secondItem.displayName)')
  tests = tests.slice(0, raceStart) + race + tests.slice(raceEnd)
  tests = replace(tests, 'expect(readMarketInstallations).not.toHaveBeenCalled()', 'expect(readMarketInstallations).toHaveBeenCalledOnce()')
  tests = replace(tests, `    const pluginCard = screen.getByRole('heading', { name: '@tokensapi/tool' }).closest('.dshMarketReceipt')
    const coreCard = screen.getByRole('heading', { name: 'dsh-plugin-desktop' }).closest('.dshMarketReceipt')
    expect(pluginCard?.parentElement).toBe(coreCard?.parentElement)
    expect(document.querySelectorAll('.dshMarketReceipts')).toHaveLength(1)`,
    `    const pluginCard = screen.getByRole('heading', { name: '@tokensapi/tool' }).closest('.dshMarketReceipt')
    expect(pluginCard?.parentElement?.className).toBe('dshMarketReceipts')
    expect(screen.queryByRole('heading', { name: 'dsh-plugin-desktop' })).toBeNull()`)
  const start = tests.indexOf("  it('opens and closes the shared Market surface")
  if (start < 0) throw new Error('market-home: sidebar test anchor changed')
  const end = tests.indexOf("\ndescribe('product market update UI'", start)
  if (end < 0) throw new Error('market-home: update tests anchor changed')
  const before = tests.slice(0, start)
  let sidebar = tests.slice(start, end)
  sidebar = replace(sidebar, 'vi.mocked(readMarketState).mockResolvedValue(emptyState)',
    "vi.mocked(readMarketState).mockResolvedValue(emptyState)\n    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ kind: 'profile', bundleId: 'launcher-plugin', packageName: '@tokensapi/launcher-plugin', status: 'active', action: 'uninstall' }] })")
  sidebar = replace(sidebar, 'name: en.emptyTitle', "name: '@tokensapi/launcher-plugin'")
  return before + sidebar + tests.slice(end)
}
