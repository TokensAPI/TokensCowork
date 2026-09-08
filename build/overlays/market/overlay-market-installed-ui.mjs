function replaceOnce(source, anchor, replacement, label) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`prepare-desktop: 未找到${label}锚点，请复查市场已安装界面覆盖`)
  }
  return source.replace(anchor, replacement)
}

/** 将不可卸载的 Profile 核心依赖从普通插件列表中分组展示。 */
export function separateInstalledSystemComponents({ settingsTab, locales, tests }) {
  const viewStart = settingsTab.indexOf('function InstalledView(')
  const viewEnd = settingsTab.indexOf('\nfunction InstallationCard(', viewStart)
  if (viewStart < 0 || viewEnd < 0) {
    throw new Error('prepare-desktop: 未找到已安装视图边界，请复查市场已安装界面覆盖')
  }
  let installedView = settingsTab.slice(viewStart, viewEnd)
  const listAnchor = `  return (
    <div className="dshMarketContent">`
  const listReplacement = `  const manageable = props.installations.filter(item => item.action === 'uninstall')
  const system = props.installations.filter(item => item.action === 'none')
  return (
    <div className="dshMarketContent">`
  installedView = replaceOnce(installedView, listAnchor, listReplacement, '已安装列表分组')

  const contentAnchor = `      {props.installations.length === 0 ? (
        <div className="dshMarketEmpty"><h2>{props.t('noInstalled')}</h2><p>{props.t('noInstalledBody')}</p></div>
      ) : (
        <div className="dshMarketReceipts">
          {props.installations.map(installation => (
            <InstallationCard`
  const contentReplacement = `      {manageable.length === 0 ? (
        <div className="dshMarketEmpty"><h2>{props.t('noInstalled')}</h2><p>{props.t('noInstalledBody')}</p></div>
      ) : (
        <div className="dshMarketReceipts">
          {manageable.map(installation => (
            <InstallationCard`
  installedView = replaceOnce(installedView, contentAnchor, contentReplacement, '可管理插件列表')

  const closeAnchor = `        </div>
      )}
    </div>
  )
}`
  const closeReplacement = `        </div>
      )}
      {system.length > 0 && <>
        <div className="dshMarketSectionHead">
          <div><h2>{props.t('systemComponents')}</h2><p>{props.t('systemComponentsBody')}</p></div>
        </div>
        <div className="dshMarketReceipts">
          {system.map(installation => (
            <InstallationCard
              key={installation.bundleId}
              installation={installation}
              operationPending={props.operationPending}
              onUninstall={props.onUninstall}
              t={props.t}
            />
          ))}
        </div>
      </>}
    </div>
  )
}`
  installedView = replaceOnce(installedView, closeAnchor, closeReplacement, '系统组件区段')
  settingsTab = settingsTab.slice(0, viewStart) + installedView + settingsTab.slice(viewEnd)
  settingsTab = replaceOnce(
    settingsTab,
    `<Pill>{props.t('profileDependency')}</Pill>`,
    `<Pill>{props.t(installation.action === 'none' ? 'immutablePlugin' : 'profileDependency')}</Pill>`,
    '系统组件标签',
  )

  for (const [anchor, replacement] of [
    ["  installedBody: '这里显示当前 Profile 的直接插件依赖，包括通过其他插件市场或命令行安装的插件。可卸载的插件只提供卸载操作。',", "  installedBody: '这里显示当前 Profile 中可管理的插件，包括通过插件市场或命令行安装的插件。',\n  systemComponents: '系统组件',\n  systemComponentsBody: 'Tokens Cowork 运行所需的核心组件，由应用统一维护，不提供单独卸载。',"],
    ["  installedBody: 'Direct plugin dependencies in the active Profile appear here, including plugins installed by other markets or the CLI. Removable plugins offer uninstall only.',", "  installedBody: 'Manage removable plugins in the active Profile, including plugins installed from a market or the CLI.',\n  systemComponents: 'System components',\n  systemComponentsBody: 'Core components required by Tokens Cowork are maintained with the app and cannot be uninstalled separately.',"],
  ]) locales = replaceOnce(locales, anchor, replacement, '中英文文案')

  const testAnchor = `  it('explains that package operations require Desktop when the optional Host capability returns 503', async () => {`
  const testCase = `  it('separates immutable system components from removable installed plugins', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [
      { kind: 'profile', bundleId: 'core', packageName: '@deepseek-ai/dsh-base', status: 'active', action: 'none' },
      { kind: 'profile', bundleId: 'tool', packageName: '@tokensapi/dsh-tool', status: 'active', action: 'uninstall' },
    ] })
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: en.systemComponents })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '@deepseek-ai/dsh-base' })).toBeTruthy()
    expect(screen.getByRole('button', { name: \`${'${en.uninstall}'}: @tokensapi/dsh-tool\` })).toBeTruthy()
    expect(screen.queryByRole('button', { name: \`${'${en.uninstall}'}: @deepseek-ai/dsh-base\` })).toBeNull()
  })

`
  tests = replaceOnce(tests, testAnchor, testCase + testAnchor, '系统组件分组测试')
  return { settingsTab, locales, tests }
}
