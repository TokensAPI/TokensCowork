
describe('product market installed home', () => {
  const localPlugin = { kind: 'profile', bundleId: 'home-plugin', packageName: '@tokensapi/home-plugin', status: 'active', action: 'uninstall' } as const
  const homeProps = { t, readLocale: () => 'en' } as MarketSettingsTabProps

  it('opens with real local inventory while source state and updates are pending', async () => {
    vi.mocked(readMarketState).mockImplementation(() => new Promise(() => {}))
    vi.mocked(readMarketInstallations)
      .mockResolvedValueOnce({ installations: [localPlugin] })
      .mockImplementationOnce(() => new Promise(() => {}))
    render(<MarketSettingsTab {...homeProps} />)
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installed }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: en.checkingUpdates })).toBeTruthy()
    expect(readMarketCatalog).not.toHaveBeenCalled()
  })

  it('shows local inventory when both market state and update requests fail', async () => {
    vi.mocked(readMarketState).mockRejectedValue(new Error('market offline'))
    vi.mocked(readMarketInstallations)
      .mockResolvedValueOnce({ installations: [localPlugin] })
      .mockRejectedValueOnce(new Error('updates offline'))
    render(<MarketSettingsTab {...homeProps} />)
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    expect(await screen.findByText(en.updateCheckFailed)).toBeTruthy()
    expect(screen.queryByText('market offline')).toBeNull()
  })

  it('shows loading, then an empty list with guidance to find plugins', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    let resolveInventory!: (value: { installations: [] }) => void
    vi.mocked(readMarketInstallations)
      .mockImplementationOnce(() => new Promise(resolve => { resolveInventory = resolve }))
      .mockResolvedValue({ installations: [] })
    render(<MarketSettingsTab {...homeProps} />)
    expect(screen.getByText(en.loadingInstallations)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.noInstalled })).toBeNull()
    await act(async () => { resolveInventory({ installations: [] }) })
    expect(await screen.findByRole('heading', { name: en.noInstalled })).toBeTruthy()
    expect(screen.getByText(en.noInstalledBody)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installable })).toBeTruthy()
  })

  it.each([500, 503])('retries a local inventory failure (%s) without requiring a catalog', async status => {
    vi.mocked(readMarketState).mockRejectedValue(new Error('offline'))
    vi.mocked(readMarketInstallations)
      .mockRejectedValueOnce(Object.assign(new Error('private transport'), { status }))
      .mockResolvedValue({ installations: [localPlugin] })
    render(<MarketSettingsTab {...homeProps} />)
    expect(await screen.findByRole('heading', { name: status === 503 ? en.desktopRequiredTitle : en.installationsError })).toBeTruthy()
    expect(screen.queryByText('private transport')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
  })

  it('excludes read-only components from the Installed management list', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [
      localPlugin, { ...localPlugin, bundleId: 'builtin', packageName: '@tokensapi/builtin', action: 'none' },
    ] })
    render(<MarketSettingsTab {...homeProps} />)
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '@tokensapi/builtin' })).toBeNull()
    expect(screen.queryByRole('button', { name: en.uninstall + ': @tokensapi/builtin' })).toBeNull()
    expect(screen.queryByRole('button', { name: en.updatePlugin + ': @tokensapi/builtin' })).toBeNull()
    expect(screen.getByRole('button', { name: en.uninstall + ': ' + localPlugin.packageName })).toBeTruthy()
  })

  it('switches to searchable Installable and back to refreshed local inventory', async () => {
    const item = makeInstallableItem(firstSource)
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin] })
    vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([item]))
    render(<MarketSettingsTab {...homeProps} />)
    await screen.findByRole('heading', { name: localPlugin.packageName })
    fireEvent.click(screen.getByRole('button', { name: en.installable }))
    expect(await screen.findByRole('button', { name: en.install + ': ' + item.displayName })).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: en.noInstalled })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: localPlugin.packageName })).toBeNull()
  })

  it('re-reads Host inventory after install, then removes an uninstalled plugin', async () => {
    const item = makeInstallableItem(firstSource)
    const installed = { ...localPlugin, packageName: item.package!.name }
    let inventory: readonly typeof installed[] = []
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([item]))
    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))
    vi.mocked(previewMarketOperation).mockImplementation(async request => ({
      action: request.action, previewId: 'home-operation', ...makeOperationTarget({ packageName: installed.packageName }), expiresAt: '2099-01-01',
    }))
    vi.mocked(executeMarketOperation).mockImplementationOnce(async () => {
      inventory = [installed]
      return { action: 'install', packageName: installed.packageName, version: '2.3.4', restartToken: 'restart' }
    }).mockImplementationOnce(async () => {
      inventory = []
      return { action: 'uninstall', packageName: installed.packageName, restartToken: 'restart' }
    })
    render(<MarketSettingsTab {...homeProps} />)
    await screen.findByRole('heading', { name: en.noInstalled })
    fireEvent.click(screen.getByRole('button', { name: en.installable }))
    fireEvent.click(await screen.findByRole('button', { name: en.install + ': ' + item.displayName }))
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    await screen.findByRole('heading', { name: en.installComplete })
    fireEvent.click(screen.getByRole('button', { name: en.restartLater }))
    const readsAfterInstall = vi.mocked(readMarketInstallations).mock.calls.length
    expect(readsAfterInstall).toBeGreaterThan(2)
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: installed.packageName })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.uninstall + ': ' + installed.packageName }))
    fireEvent.click(await screen.findByRole('button', { name: en.confirmUninstall }))
    await screen.findByRole('heading', { name: en.uninstallComplete })
    fireEvent.click(screen.getByRole('button', { name: en.restartLater }))
    expect(await screen.findByRole('heading', { name: en.noInstalled })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: installed.packageName })).toBeNull()
    expect(executeMarketOperation).toHaveBeenCalledTimes(2)
  })

  it('renders the installed homepage in Chinese', async () => {
    const { zh } = await import('../src/client/locales.js')
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
    const chinese = ((key: MarketLocaleKey) => zh[key]) as MarketSettingsTabProps['t']
    render(<MarketSettingsTab {...homeProps} t={chinese} readLocale={() => 'zh-CN'} />)
    expect(await screen.findByRole('heading', { name: zh.noInstalled })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.installed }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(zh.noInstalledBody)).toBeTruthy()
  })

  it('partitions all, uninstalled and installed plugins without exposing read-only actions', async () => {
    const installed = makeInstallableItem(firstSource, 'installed-card', 'Installed Card', localPlugin.packageName)
    const fresh = makeInstallableItem(firstSource, 'fresh-card', 'Fresh Card', '@tokensapi/fresh-card')
    const readonly = { ...localPlugin, bundleId: 'core', packageName: '@tokensapi/core', action: 'none' } as const
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin, readonly] })
    vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([installed, fresh]))
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [installed, fresh]))
    render(<MarketSettingsTab {...homeProps} />)
    const card = (await screen.findByRole('heading', { name: localPlugin.packageName })).closest('.dshMarketReceipt')!
    expect(card.parentElement?.className).toBe('dshMarketReceipts')
    expect(screen.queryByRole('heading', { name: fresh.package!.name })).toBeNull()
    expect(screen.queryByRole('heading', { name: readonly.packageName })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installable }))
    expect(await screen.findByRole('button', { name: en.install + ': ' + fresh.displayName })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.install + ': ' + installed.displayName })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect(await screen.findByRole('button', { name: new RegExp(installed.displayName) })).toBeTruthy()
    expect(screen.getByRole('button', { name: new RegExp(fresh.displayName) })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.uninstall + ': ' + readonly.packageName })).toBeNull()
  })

  it('does not offer catalog packages when the inventory needed for exclusion is unavailable', async () => {
    const item = makeInstallableItem(firstSource)
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([item]))
    vi.mocked(readMarketInstallations).mockRejectedValue(new Error('inventory offline'))
    render(<MarketSettingsTab {...homeProps} initialView="installable" />)
    expect(await screen.findByRole('heading', { name: en.installableError })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.install + ': ' + item.displayName })).toBeNull()
  })

  it.each(['en', 'zh-CN'])('uses the native Installed receipt layout in %s with update actions', async locale => {
    const { en, zh } = await import('../src/client/locales.js')
    const messages = locale === 'en' ? en : zh
    const translate = ((key: MarketLocaleKey) => messages[key]) as MarketSettingsTabProps['t']
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{
      ...localPlugin, version: '1.0.0', updateStatus: 'available', updateVersion: '1.1.0',
    }] })
    render(<MarketSettingsTab {...homeProps} t={translate} readLocale={() => locale} />)
    const heading = await screen.findByRole('heading', { name: localPlugin.packageName })
    const receipt = heading.closest('article')!
    expect(receipt.className).toBe('dshMarketReceipt')
    expect(receipt.parentElement?.className).toBe('dshMarketReceipts')
    expect(receipt.querySelector('.dshMarketReceiptTitle h3')).toBe(heading)
    expect(receipt.querySelector('.dshMarketReceiptMeta')).toBeTruthy()
    expect(receipt.querySelector('.dshMarketReceiptActions')).toBeTruthy()
    expect(within(receipt).getByText(messages.profileDependency)).toBeTruthy()
    expect(within(receipt).getByText(messages.activePlugin)).toBeTruthy()
    expect(within(receipt).getByText(messages.installedVersion + ': 1.0.0')).toBeTruthy()
    expect(within(receipt).getByRole('button', { name: messages.updatePlugin + ': ' + localPlugin.packageName })).toBeTruthy()
    expect(within(receipt).getByRole('button', { name: messages.uninstall + ': ' + localPlugin.packageName })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('.dshMarketGrid, .dshMarketCardTop, .dshMarketInstalledCard')).toBeNull()
    expect(readMarketInstallable).not.toHaveBeenCalled()
  })
})
