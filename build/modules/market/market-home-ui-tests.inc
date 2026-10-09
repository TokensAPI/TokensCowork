
describe('product Discover home and installed details', () => {
  const localPlugin = { kind: 'profile', bundleId: 'home-plugin', packageName: '@tokensapi/home-plugin', status: 'active', action: 'uninstall' } as const
  const homeProps = { t, readLocale: () => 'en' } as MarketSettingsTabProps
  const installedItem = makeInstallableItem(firstSource, 'installed-card', 'Installed Card', localPlugin.packageName)
  const freshItem = makeInstallableItem(firstSource, 'fresh-card', 'Fresh Card', '@tokensapi/fresh-card')

  function browse() {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [installedItem, freshItem]))
  }

  it.each(['en', 'zh-CN'])('opens on native Discover with installed badges and no Installable tab in %s', async locale => {
    const { en, zh } = await import('../src/client/locales.js')
    const messages = locale === 'en' ? en : zh
    const translate = ((key: MarketLocaleKey) => messages[key]) as MarketSettingsTabProps['t']
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin] })
    render(<MarketSettingsTab {...homeProps} t={translate} readLocale={() => locale} />)
    const installed = await screen.findByRole('button', { name: /Installed Card/ })
    const fresh = screen.getByRole('button', { name: /Fresh Card/ })
    expect(screen.getByRole('button', { name: messages.discover }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: messages.installable })).toBeNull()
    expect(installed.className).toBe('dshMarketCard')
    expect(installed.parentElement?.className).toBe('dshMarketGrid')
    expect(installed.getAttribute('data-installed')).toBe('true')
    expect(within(installed).getByText(messages.installed).className).toContain('dshMarketInstalledBadge')
    expect(installed.hasAttribute('disabled')).toBe(false)
    expect(fresh.hasAttribute('data-installed')).toBe(false)
    expect(within(fresh).queryByText(messages.installed)).toBeNull()
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(readMarketInstallable).not.toHaveBeenCalled()
    expect(readMarketInstallations).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(vi.mocked(readMarketInstallations).mock.calls.some(call => call[1] === true)).toBe(false)
  })

  it('shows Discover cards while local inventory is pending, then marks installed cards', async () => {
    browse()
    let resolveInventory!: (value: { installations: [typeof localPlugin] }) => void
    vi.mocked(readMarketInstallations).mockImplementationOnce(() => new Promise(resolve => { resolveInventory = resolve }))
    render(<MarketSettingsTab {...homeProps} />)
    const installed = await screen.findByRole('button', { name: /Installed Card/ })
    expect(installed.hasAttribute('data-installed')).toBe(false)
    expect(screen.getByRole('button', { name: /Fresh Card/ })).toBeTruthy()
    await act(async () => { resolveInventory({ installations: [localPlugin] }) })
    expect(installed.getAttribute('data-installed')).toBe('true')
  })

  it('keeps the native install confirmation and synchronizes the installed badge after success', async () => {
    browse()
    let inventory: readonly import('../src/api-types.js').MarketInstallationView[] = []
    const installed = { ...localPlugin, packageName: freshItem.package!.name }
    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'install', previewId: 'discover-install', ...makeOperationTarget({ packageName: installed.packageName }), expiresAt: '2099-01-01',
    })
    vi.mocked(executeMarketOperation).mockImplementation(async () => {
      inventory = [installed]
      return { action: 'install', packageName: installed.packageName, version: '2.3.4', restartToken: 'restart' }
    })
    render(<MarketSettingsTab {...homeProps} />)
    const card = await screen.findByRole('button', { name: /Fresh Card/ })
    fireEvent.click(card)
    const confirmation = await screen.findByRole('dialog', { name: en.confirmInstallTitle })
    expect(confirmation.classList.contains('dshMarketWideModal')).toBe(true)
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'install', sourceRecordId: firstSource.sourceRecordId, itemId: freshItem.id }, expect.any(AbortSignal))
    expect(executeMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: en.confirmInstall }))
    await screen.findByRole('heading', { name: en.installComplete })
    fireEvent.click(screen.getByRole('button', { name: en.restartLater }))
    await waitFor(() => expect(card.getAttribute('data-installed')).toBe('true'))
    fireEvent.click(card)
    const details = await screen.findByRole('dialog', { name: freshItem.displayName })
    expect(await within(details).findByRole('heading', { name: installed.packageName })).toBeTruthy()
    expect(within(details).queryByRole('button', { name: en.confirmInstall })).toBeNull()
    expect(previewMarketOperation).toHaveBeenCalledTimes(1)
    expect(executeMarketOperation).toHaveBeenCalledWith('discover-install', expect.any(AbortSignal))
  })

  it.each(['en', 'zh-CN'])('shows live versions and uses the existing update confirmation in Discover details (%s)', async locale => {
    const { en, zh } = await import('../src/client/locales.js')
    const messages = locale === 'en' ? en : zh
    const translate = ((key: MarketLocaleKey) => messages[key]) as MarketSettingsTabProps['t']
    browse()
    let updated = false
    vi.mocked(readMarketInstallations).mockImplementation(async (_signal, updates) => ({ installations: [{
      ...localPlugin, version: updated ? '1.1.0' : '1.0.0',
      ...(updates ? { updateStatus: updated ? 'current' as const : 'available' as const, updateVersion: '1.1.0' } : {}),
    }] }))
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'update', previewId: 'discover-update', ...makeOperationTarget({ packageName: localPlugin.packageName, version: '1.1.0' }), updateFrom: '1.0.0', expiresAt: '2099-01-01',
    })
    vi.mocked(executeMarketOperation).mockImplementation(async () => {
      updated = true
      return { action: 'update', packageName: localPlugin.packageName, version: '1.1.0', restartToken: 'restart' }
    })
    render(<MarketSettingsTab {...homeProps} t={translate} readLocale={() => locale} />)
    const card = await screen.findByRole('button', { name: /Installed Card/ })
    fireEvent.click(card)
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    const update = await within(details).findByRole('button', { name: messages.updatePlugin + ': ' + localPlugin.packageName })
    expect(within(details).getByText(messages.installedVersion + ': 1.0.0')).toBeTruthy()
    expect(within(details).getByText(messages.updateAvailable + ' → 1.1.0')).toBeTruthy()
    expect(within(details).queryByRole('button', { name: messages.checkUpdates })).toBeNull()
    expect(within(details).queryByRole('button', { name: messages.retry })).toBeNull()
    expect(readMarketInstallations).toHaveBeenCalledWith(expect.any(AbortSignal), true)
    expect(within(details).queryByRole('button', { name: messages.confirmInstall })).toBeNull()
    expect(previewMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(update)
    const confirmation = await screen.findByRole('dialog', { name: messages.confirmUpdateTitle })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'update', bundleId: localPlugin.bundleId }, expect.any(AbortSignal))
    expect(executeMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: messages.cancel }))
    const returned = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(within(returned).getByRole('button', { name: messages.updatePlugin + ': ' + localPlugin.packageName }))
    const confirmed = await screen.findByRole('dialog', { name: messages.confirmUpdateTitle })
    fireEvent.click(within(confirmed).getByRole('button', { name: messages.confirmUpdate }))
    await screen.findByRole('heading', { name: messages.updateComplete })
    fireEvent.click(screen.getByRole('button', { name: messages.restartLater }))
    fireEvent.click(card)
    const current = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(current).findByText(messages.upToDate)).toBeTruthy()
    expect(within(current).queryByRole('button', { name: messages.checkUpdates })).toBeNull()
    expect(within(current).queryByRole('button', { name: messages.retry })).toBeNull()
    expect(within(current).getByText(messages.installedVersion + ': 1.1.0')).toBeTruthy()
    expect(within(current).queryByRole('button', { name: messages.updatePlugin + ': ' + localPlugin.packageName })).toBeNull()
    expect(executeMarketOperation).toHaveBeenCalledWith('discover-update', expect.any(AbortSignal))
    expect(card.getAttribute('data-installed')).toBe('true')
  })

  it('renders the local receipt while updates are pending, then offers retry after an update read fails', async () => {
    browse()
    let rejectUpdates!: (cause: Error) => void
    vi.mocked(readMarketInstallations).mockImplementation(async (_signal, updates) => updates
      ? await new Promise<{ installations: readonly typeof localPlugin[] }>((_resolve, reject) => { rejectUpdates = reject })
      : { installations: [localPlugin] })
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(details).findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    await waitFor(() => expect(rejectUpdates).toBeDefined())
    await act(async () => { rejectUpdates(new Error('updates offline')) })
    expect(await within(details).findByText(en.updateCheckFailed)).toBeTruthy()
    expect(within(details).getByRole('button', { name: en.uninstall + ': ' + localPlugin.packageName })).toBeTruthy()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, version: '1.0.0', updateVersion: '1.1.0', updateStatus: 'available' }] })
    fireEvent.click(within(details).getByRole('button', { name: en.retry }))
    expect(await within(details).findByRole('button', { name: en.updatePlugin + ': ' + localPlugin.packageName })).toBeTruthy()
    expect(within(details).queryByText(en.updateCheckFailed)).toBeNull()
  })

  it('keeps update authorization errors in the details and executes nothing', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, version: '1.0.0', updateVersion: '1.1.0', updateStatus: 'available' }] })
    vi.mocked(previewMarketOperation).mockRejectedValue(new Error('Plugin is no longer authorized'))
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(await within(details).findByRole('button', { name: en.updatePlugin + ': ' + localPlugin.packageName }))
    expect(await within(details).findByText('Plugin is no longer authorized')).toBeTruthy()
    expect(executeMarketOperation).not.toHaveBeenCalled()
    expect(within(details).getByRole('button', { name: en.uninstall + ': ' + localPlugin.packageName })).toBeTruthy()
  })

  it('retries a failed update status returned by Host without a transport error', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, version: '1.0.0', updateStatus: 'failed' }] })
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(details).findByText(en.updateCheckFailed)).toBeTruthy()
    expect(within(details).queryByRole('button', { name: en.checkUpdates })).toBeNull()
    const retry = await within(details).findByRole('button', { name: en.retry })
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, version: '1.0.0', updateStatus: 'available', updateVersion: '1.1.0' }] })
    fireEvent.click(retry)
    expect(await within(details).findByRole('button', { name: en.updatePlugin + ': ' + localPlugin.packageName })).toBeTruthy()
    expect(within(details).getByText(en.updateAvailable + ' → 1.1.0')).toBeTruthy()
    expect(within(details).queryByRole('button', { name: en.retry })).toBeNull()
  })

  it('keeps failed updates in the confirmation and returns to details on cancel', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, version: '1.0.0', updateVersion: '1.1.0', updateStatus: 'available' }] })
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'update', previewId: 'failed-update', ...makeOperationTarget({ packageName: localPlugin.packageName }), expiresAt: '2099-01-01' })
    vi.mocked(executeMarketOperation).mockRejectedValue(new Error('Update failed'))
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(await within(details).findByRole('button', { name: en.updatePlugin + ': ' + localPlugin.packageName }))
    const confirmation = await screen.findByRole('dialog', { name: en.confirmUpdateTitle })
    fireEvent.click(within(confirmation).getByRole('button', { name: en.confirmUpdate }))
    expect(await within(confirmation).findByText('Update failed')).toBeTruthy()
    fireEvent.click(within(confirmation).getByRole('button', { name: en.cancel }))
    expect(await screen.findByRole('dialog', { name: installedItem.displayName })).toBeTruthy()
    expect((await screen.findByRole('button', { name: /Installed Card/ })).getAttribute('data-installed')).toBe('true')
  })

  it('uses native uninstall confirmation from Discover details and removes the installed badge', async () => {
    browse()
    let inventory: readonly typeof localPlugin[] = [localPlugin]
    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'uninstall', previewId: 'discover-uninstall', ...makeOperationTarget({ packageName: localPlugin.packageName }), expiresAt: '2099-01-01' })
    vi.mocked(executeMarketOperation).mockImplementation(async () => {
      inventory = []
      return { action: 'uninstall', packageName: localPlugin.packageName, restartToken: 'restart' }
    })
    render(<MarketSettingsTab {...homeProps} />)
    const card = await screen.findByRole('button', { name: /Installed Card/ })
    fireEvent.click(card)
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(await within(details).findByRole('button', { name: en.uninstall + ': ' + localPlugin.packageName }))
    const confirmation = await screen.findByRole('dialog', { name: en.confirmUninstallTitle })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(within(confirmation).getByRole('button', { name: en.confirmUninstall }))
    await screen.findByRole('heading', { name: en.uninstallComplete })
    fireEvent.click(screen.getByRole('button', { name: en.restartLater }))
    await waitFor(() => expect(card.hasAttribute('data-installed')).toBe(false))
    expect(within(card).queryByText(en.installed)).toBeNull()
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'uninstall', bundleId: localPlugin.bundleId }, expect.any(AbortSignal))
  })

  it('does not give read-only components update, uninstall or install actions', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, action: 'none', version: '1.0.0', updateStatus: 'available', updateVersion: '2.0.0' }] })
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(details).findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    expect(within(details).queryByRole('button', { name: en.updatePlugin + ': ' + localPlugin.packageName })).toBeNull()
    expect(within(details).queryByRole('button', { name: en.uninstall + ': ' + localPlugin.packageName })).toBeNull()
    expect(within(details).queryByRole('button', { name: en.confirmInstall })).toBeNull()
    expect(previewMarketOperation).not.toHaveBeenCalled()
    expect(vi.mocked(readMarketInstallations).mock.calls.some(call => call[1] === true)).toBe(false)
    fireEvent.click(within(details).getByRole('button', { name: en.close }))
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: en.noInstalled })).toBeTruthy()
  })

  it.each([500, 503])('keeps Discover available and retries a bounded inventory failure (%s)', async status => {
    browse()
    vi.mocked(readMarketInstallations).mockRejectedValueOnce(Object.assign(new Error('private transport'), { status }))
      .mockResolvedValue({ installations: [localPlugin] })
    render(<MarketSettingsTab {...homeProps} />)
    const card = await screen.findByRole('button', { name: /Installed Card/ })
    const message = status === 503 ? en.desktopUnavailable : en.installationsError
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.queryByText('private transport')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(card.getAttribute('data-installed')).toBe('true'))
    expect(screen.queryByText(message)).toBeNull()
  })

  it('fails closed in details when local inventory is unavailable and allows a retry', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockRejectedValue(new Error('inventory offline'))
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Fresh Card/ }))
    const details = await screen.findByRole('dialog', { name: freshItem.displayName })
    expect(await within(details).findByText(en.installationsError)).toBeTruthy()
    expect(previewMarketOperation).not.toHaveBeenCalled()
    expect(within(details).queryByRole('button', { name: en.confirmInstall })).toBeNull()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'install', previewId: 'retry-install', ...makeOperationTarget(), expiresAt: '2099-01-01' })
    fireEvent.click(within(details).getByRole('button', { name: en.retry }))
    expect(await screen.findByRole('dialog', { name: en.confirmInstallTitle })).toBeTruthy()
  })

  it('refreshes badges after switching from Installed and keeps local management usable offline', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin] })
    render(<MarketSettingsTab {...homeProps} />)
    const card = await screen.findByRole('button', { name: /Installed Card/ })
    expect(card.getAttribute('data-installed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    await waitFor(() => expect((screen.getByRole('button', { name: /Installed Card/ })).hasAttribute('data-installed')).toBe(false))
    vi.mocked(readMarketState).mockRejectedValue(new Error('market offline'))
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin] })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    const receipt = (await screen.findByRole('heading', { name: localPlugin.packageName })).closest('article')!
    expect(receipt.className).toBe('dshMarketReceipt')
    expect(receipt.parentElement?.className).toBe('dshMarketReceipts')
    expect(within(receipt).getByRole('button', { name: en.uninstall + ': ' + localPlugin.packageName })).toBeTruthy()
  })

  it('shows the native empty Discover state and the empty Installed state separately', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, []))
    render(<MarketSettingsTab {...homeProps} />)
    expect(await screen.findByRole('heading', { name: en.noResults })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.noInstalled })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: en.noInstalled })).toBeTruthy()
    expect(screen.getByText(en.noInstalledBody)).toBeTruthy()
  })

  it('retains the local Installed list when catalog and update checks fail', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockRejectedValue(new Error('catalog offline'))
    vi.mocked(readMarketInstallations).mockImplementation(async (_signal, updates) => {
      if (updates) throw new Error('updates offline')
      return { installations: [localPlugin] }
    })
    render(<MarketSettingsTab {...homeProps} />)
    expect(await screen.findByRole('heading', { name: en.catalogError })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    expect(await screen.findByText(en.updateCheckFailed)).toBeTruthy()
  })
})
