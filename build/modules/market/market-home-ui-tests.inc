
describe('product Discover home and installed details', () => {
  const localPlugin = {
    kind: 'profile' as const,
    packageName: '@tokensapi/home-plugin',
    version: '1.0.0',
    enabled: true,
    installed: true,
    toggleable: true,
    removable: true,
  }
  const homeProps = { t, readLocale: () => 'en' } as MarketSettingsTabProps
  const installedItem = makeInstallableItem(firstSource, 'installed-card', 'Installed Card', localPlugin.packageName)
  const freshItem = makeInstallableItem(firstSource, 'fresh-card', 'Fresh Card', '@tokensapi/fresh-card')

  /** 卡片右上角的状态标记：install =「+」，installed =「✓」，没有则 undefined。 */
  const markOf = (card: HTMLElement) => card.querySelector('.dshMarketCardMark')?.getAttribute('data-mark')
  /** 卡片自身的状态（决定已安装的略深底色）：install / installed，清单未到为 null。 */
  const stateOf = (card: HTMLElement) => card.getAttribute('data-state')
  /** 卡片底部标签行里的状态标签：[类名, 文字]，没有则 undefined；断言它是这一行的最后一格。 */
  const badgeOf = (card: HTMLElement) => {
    const badge = card.querySelector('.dshMarketInstallableBadge, .dshMarketInstalledBadge')
    if (badge === null) return undefined
    expect(badge.parentElement?.className).toBe('dshMarketTags')
    expect(badge.parentElement?.lastElementChild).toBe(badge)
    return [badge.className, badge.textContent]
  }

  function browse() {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [installedItem, freshItem]))
  }

  it.each(['en', 'zh-CN'])('opens on native Discover with one card skeleton, + / ✓ marks and no Installable tab in %s', async locale => {
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
    expect(markOf(installed)).toBe('installed')
    expect(markOf(fresh)).toBe('install')
    // Same upstream card for both: same class and attributes; only data-state differs, not disabled.
    expect([...installed.attributes].map(attribute => attribute.name)).toEqual([...fresh.attributes].map(attribute => attribute.name))
    expect(stateOf(installed)).toBe('installed')
    expect(stateOf(fresh)).toBe('install')
    // The state is also spelled out as the last upstream Pill on the card's bottom tag row.
    expect(badgeOf(installed)).toEqual(['dshMarketInstalledBadge', messages.installed])
    expect(badgeOf(fresh)).toEqual(['dshMarketInstallableBadge', messages.installable])
    expect(installed.hasAttribute('disabled')).toBe(false)
    // The marks are drawn inside the card button: no extra control on the page.
    expect(installed.querySelector('.dshMarketCardMark')?.getAttribute('aria-hidden')).toBe('true')
    expect(within(installed).queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(readMarketInstallable).not.toHaveBeenCalled()
    // Badges read the local inventory only; no update lookup leaves Discover.
    expect(readMarketInstallations).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(vi.mocked(readMarketInstallations).mock.calls.some(call => call[1] === true)).toBe(false)
  })

  it('shows Discover cards without marks while local inventory is pending, then marks them', async () => {
    browse()
    let resolveInventory!: (value: { installations: [typeof localPlugin] }) => void
    vi.mocked(readMarketInstallations).mockImplementationOnce(() => new Promise(resolve => { resolveInventory = resolve }))
    render(<MarketSettingsTab {...homeProps} />)
    const installed = await screen.findByRole('button', { name: /Installed Card/ })
    expect(markOf(installed)).toBeUndefined()
    expect(stateOf(installed)).toBeNull()
    expect(badgeOf(installed)).toBeUndefined()
    expect(markOf(screen.getByRole('button', { name: /Fresh Card/ }))).toBeUndefined()
    expect(badgeOf(screen.getByRole('button', { name: /Fresh Card/ }))).toBeUndefined()
    await act(async () => { resolveInventory({ installations: [localPlugin] }) })
    expect(markOf(installed)).toBe('installed')
    expect(stateOf(installed)).toBe('installed')
    expect(badgeOf(installed)).toEqual(['dshMarketInstalledBadge', en.installed])
  })

  it('keeps the native install confirmation and turns + into ✓ after success', async () => {
    browse()
    let inventory: readonly import('../src/api-types.js').MarketInstallationView[] = []
    const installed = { ...localPlugin, packageName: freshItem.package!.name }
    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'install', previewId: 'discover-install', ...makeOperationTarget({ packageName: installed.packageName }), expiresAt: '2099-01-01',
    })
    vi.mocked(executeMarketOperation).mockImplementation(async () => {
      inventory = [installed]
      return { action: 'install', packageName: installed.packageName, version: '2.3.4', application: 'applied' }
    })
    render(<MarketSettingsTab {...homeProps} />)
    const card = await screen.findByRole('button', { name: /Fresh Card/ })
    fireEvent.click(card)
    const confirmation = await screen.findByRole('dialog', { name: en.confirmInstallTitle })
    expect(confirmation.classList.contains('dshMarketWideModal')).toBe(true)
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'install', sourceRecordId: firstSource.sourceRecordId, itemId: freshItem.id }, expect.any(AbortSignal))
    expect(executeMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: en.confirmInstall }))
    expect(await screen.findByText(en.installComplete)).toBeTruthy()
    await waitFor(() => expect(markOf(card)).toBe('installed'))
    expect(badgeOf(card)).toEqual(['dshMarketInstalledBadge', en.installed])
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
      return { action: 'update', packageName: localPlugin.packageName, version: '1.1.0', application: 'applied' }
    })
    render(<MarketSettingsTab {...homeProps} t={translate} readLocale={() => locale} />)
    const card = await screen.findByRole('button', { name: /Installed Card/ })
    fireEvent.click(card)
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    const update = await within(details).findByRole('button', { name: `${messages.updatePlugin}: ${localPlugin.packageName}` })
    expect(within(details).getByText(`${messages.pluginVersion}: 1.0.0`)).toBeTruthy()
    expect(within(details).getByText(`${messages.updateAvailable} → 1.1.0`)).toBeTruthy()
    expect(within(details).queryByRole('button', { name: messages.checkUpdates })).toBeNull()
    expect(within(details).queryByRole('button', { name: messages.retry })).toBeNull()
    expect(readMarketInstallations).toHaveBeenCalledWith(expect.any(AbortSignal), true)
    expect(within(details).queryByRole('button', { name: messages.confirmInstall })).toBeNull()
    expect(previewMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(update)
    const confirmation = await screen.findByRole('dialog', { name: messages.confirmUpdateTitle })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    // The copy states the two steps and that configuration survives them.
    expect(within(confirmation).getByText(messages.confirmUpdateBody)).toBeTruthy()
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'update', packageName: localPlugin.packageName }, expect.any(AbortSignal))
    expect(executeMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: messages.cancel }))
    const returned = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(within(returned).getByRole('button', { name: `${messages.updatePlugin}: ${localPlugin.packageName}` }))
    const confirmed = await screen.findByRole('dialog', { name: messages.confirmUpdateTitle })
    fireEvent.click(within(confirmed).getByRole('button', { name: messages.confirmUpdate }))
    expect(await screen.findByText(messages.updateComplete)).toBeTruthy()
    fireEvent.click(card)
    const current = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(current).findByText(messages.upToDate)).toBeTruthy()
    expect(within(current).queryByRole('button', { name: messages.checkUpdates })).toBeNull()
    expect(within(current).queryByRole('button', { name: messages.retry })).toBeNull()
    expect(within(current).getByText(`${messages.pluginVersion}: 1.1.0`)).toBeTruthy()
    expect(within(current).queryByRole('button', { name: `${messages.updatePlugin}: ${localPlugin.packageName}` })).toBeNull()
    expect(executeMarketOperation).toHaveBeenCalledWith('discover-update', expect.any(AbortSignal))
    expect(markOf(card)).toBe('installed')
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
    expect(within(details).getByRole('button', { name: `${en.uninstall}: ${localPlugin.packageName}` })).toBeTruthy()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, updateVersion: '1.1.0', updateStatus: 'available' }] })
    fireEvent.click(within(details).getByRole('button', { name: en.retry }))
    expect(await within(details).findByRole('button', { name: `${en.updatePlugin}: ${localPlugin.packageName}` })).toBeTruthy()
    expect(within(details).queryByText(en.updateCheckFailed)).toBeNull()
  })

  it('keeps update authorization errors in the details and executes nothing', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, updateVersion: '1.1.0', updateStatus: 'available' }] })
    vi.mocked(previewMarketOperation).mockRejectedValue(new Error('Plugin is no longer authorized'))
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(await within(details).findByRole('button', { name: `${en.updatePlugin}: ${localPlugin.packageName}` }))
    expect(await within(details).findByText('Plugin is no longer authorized')).toBeTruthy()
    expect(executeMarketOperation).not.toHaveBeenCalled()
    expect(within(details).getByRole('button', { name: `${en.uninstall}: ${localPlugin.packageName}` })).toBeTruthy()
  })

  it('retries a failed update status returned by Host without a transport error', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, updateStatus: 'failed' }] })
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(details).findByText(en.updateCheckFailed)).toBeTruthy()
    expect(within(details).queryByRole('button', { name: en.checkUpdates })).toBeNull()
    const retry = await within(details).findByRole('button', { name: en.retry })
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, updateStatus: 'available', updateVersion: '1.1.0' }] })
    fireEvent.click(retry)
    expect(await within(details).findByRole('button', { name: `${en.updatePlugin}: ${localPlugin.packageName}` })).toBeTruthy()
    expect(within(details).getByText(`${en.updateAvailable} → 1.1.0`)).toBeTruthy()
    expect(within(details).queryByRole('button', { name: en.retry })).toBeNull()
  })

  it('keeps failed updates in the confirmation and returns to details on cancel', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{ ...localPlugin, updateVersion: '1.1.0', updateStatus: 'available' }] })
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'update', previewId: 'failed-update', ...makeOperationTarget({ packageName: localPlugin.packageName }), expiresAt: '2099-01-01' })
    vi.mocked(executeMarketOperation).mockRejectedValue(new Error('Update failed'))
    render(<MarketSettingsTab {...homeProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed Card/ }))
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(await within(details).findByRole('button', { name: `${en.updatePlugin}: ${localPlugin.packageName}` }))
    const confirmation = await screen.findByRole('dialog', { name: en.confirmUpdateTitle })
    fireEvent.click(within(confirmation).getByRole('button', { name: en.confirmUpdate }))
    expect(await within(confirmation).findByText('Update failed')).toBeTruthy()
    fireEvent.click(within(confirmation).getByRole('button', { name: en.cancel }))
    expect(await screen.findByRole('dialog', { name: installedItem.displayName })).toBeTruthy()
    expect(markOf(await screen.findByRole('button', { name: /Installed Card/ }))).toBe('installed')
  })

  it('uses native uninstall confirmation from Discover details and turns ✓ back into +', async () => {
    browse()
    let inventory: readonly typeof localPlugin[] = [localPlugin]
    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'uninstall', previewId: 'discover-uninstall', ...makeOperationTarget({ packageName: localPlugin.packageName }), expiresAt: '2099-01-01' })
    vi.mocked(executeMarketOperation).mockImplementation(async () => {
      inventory = []
      return { action: 'uninstall', packageName: localPlugin.packageName, application: 'applied' }
    })
    render(<MarketSettingsTab {...homeProps} />)
    const card = await screen.findByRole('button', { name: /Installed Card/ })
    fireEvent.click(card)
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    fireEvent.click(await within(details).findByRole('button', { name: `${en.uninstall}: ${localPlugin.packageName}` }))
    const confirmation = await screen.findByRole('dialog', { name: en.confirmUninstallTitle })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(within(confirmation).getByRole('button', { name: en.confirmUninstall }))
    expect(await screen.findByText(en.uninstallComplete)).toBeTruthy()
    await waitFor(() => expect(markOf(card)).toBe('install'))
    expect(stateOf(card)).toBe('install')
    expect(badgeOf(card)).toEqual(['dshMarketInstallableBadge', en.installable])
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'uninstall', packageName: localPlugin.packageName }, expect.any(AbortSignal))
  })

  it('does not give read-only components update, uninstall or install actions', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{
      ...localPlugin, toggleable: false, removable: false, updateStatus: 'available', updateVersion: '2.0.0',
    }] })
    render(<MarketSettingsTab {...homeProps} />)
    const readOnly = await screen.findByRole('button', { name: /Installed Card/ })
    // A built-in component is installed but cannot be removed: installed tint, but no + and no ✓.
    await waitFor(() => expect(markOf(screen.getByRole('button', { name: /Fresh Card/ }))).toBe('install'))
    expect(markOf(readOnly)).toBeUndefined()
    expect(badgeOf(readOnly)).toBeUndefined()
    expect(stateOf(readOnly)).toBe('installed')
    fireEvent.click(readOnly)
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(details).findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    expect(within(details).getByText(en.immutablePlugin)).toBeTruthy()
    expect(within(details).queryByRole('switch')).toBeNull()
    expect(within(details).queryByRole('button', { name: `${en.uninstall}: ${localPlugin.packageName}` })).toBeNull()
    expect(within(details).queryByRole('button', { name: en.confirmInstall })).toBeNull()
    expect(previewMarketOperation).not.toHaveBeenCalled()
    // A bundle the market cannot remove is never checked for updates either.
    expect(vi.mocked(readMarketInstallations).mock.calls.some(call => call[1] === true)).toBe(false)
    fireEvent.click(within(details).getByRole('button', { name: en.close }))
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
  })

  it('opens the same dialog from a mark as from its card and runs nothing by itself', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin] })
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'install', previewId: 'mark-install', ...makeOperationTarget({ packageName: freshItem.package!.name }), expiresAt: '2099-01-01',
    })
    render(<MarketSettingsTab {...homeProps} />)
    const installed = await screen.findByRole('button', { name: /Installed Card/ })
    await waitFor(() => expect(markOf(installed)).toBe('installed'))
    fireEvent.click(installed.querySelector('.dshMarketCardMark')!)
    const details = await screen.findByRole('dialog', { name: installedItem.displayName })
    expect(await within(details).findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    expect(previewMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(within(details).getByRole('button', { name: en.close }))
    fireEvent.click(screen.getByRole('button', { name: /Fresh Card/ }).querySelector('.dshMarketCardMark')!)
    // The native confirmation with its warnings still stands between + and an install.
    expect(await screen.findByRole('dialog', { name: en.confirmInstallTitle })).toBeTruthy()
    expect(executeMarketOperation).not.toHaveBeenCalled()
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
    await waitFor(() => expect(markOf(card)).toBe('installed'))
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

  it('refreshes the marks after switching from Installed and keeps local management usable offline', async () => {
    browse()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin] })
    render(<MarketSettingsTab {...homeProps} />)
    const card = await screen.findByRole('button', { name: /Installed Card/ })
    await waitFor(() => expect(markOf(card)).toBe('installed'))
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: localPlugin.packageName })).toBeTruthy()
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    await waitFor(() => expect(markOf(screen.getByRole('button', { name: /Installed Card/ }))).toBe('install'))
    vi.mocked(readMarketState).mockRejectedValue(new Error('market offline'))
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [localPlugin] })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    const receipt = (await screen.findByRole('heading', { name: localPlugin.packageName })).closest('article')!
    expect(receipt.className).toBe('dshMarketReceipt')
    expect(receipt.parentElement?.className).toBe('dshMarketReceipts')
    expect(within(receipt).getByRole('button', { name: `${en.uninstall}: ${localPlugin.packageName}` })).toBeTruthy()
  })

  it('shows the native empty Discover state and the empty Installed state separately', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, []))
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
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

describe('product Discover tab contributed to the Plugins page', () => {
  const tabProps = { t, readLocale: () => 'en' } as MarketPluginsTabProps
  const tabItem = makeInstallableItem(firstSource, 'tab-card', 'Tab Card', '@tokensapi/tab-card')

  function browseTab() {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [tabItem]))
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
  }

  it('shows the product catalog without the panel header or its own view switch', async () => {
    browseTab()
    render(<MarketPluginsTab {...tabProps} />)
    expect(await screen.findByRole('button', { name: /Tab Card/ })).toBeTruthy()
    // The page's own tabs are Installed / Discover; a nested view switch would
    // show a second Installed and a Sources entry the product does not offer.
    for (const label of [en.discover, en.installed, en.sources]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    expect(screen.queryByRole('heading', { name: en.title })).toBeNull()
    expect(screen.queryByRole('link', { name: new RegExp(en.currentSource) })).toBeNull()
    expect(readMarketCatalog).toHaveBeenCalled()
    expect(readMarketInstallable).not.toHaveBeenCalled()
  })

  it('installs through the market confirmation instead of the Plugins page install dialog', async () => {
    browseTab()
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'install', previewId: 'tab-install', ...makeOperationTarget({ packageName: '@tokensapi/tab-card' }), expiresAt: '2099-01-01',
    })
    vi.mocked(executeMarketOperation).mockResolvedValue({
      action: 'install', packageName: '@tokensapi/tab-card', version: '1.2.3', application: 'applied',
    })
    const install = vi.fn()
    render(<MarketPluginsTab {...tabProps} install={install} openPackage={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Tab Card/ }))
    const confirmation = await screen.findByRole('dialog', { name: en.confirmInstallTitle })
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'install', sourceRecordId: firstSource.sourceRecordId, itemId: tabItem.id }, expect.any(AbortSignal))
    fireEvent.click(within(confirmation).getByRole('button', { name: en.confirmInstall }))
    expect(await screen.findByText(en.installComplete)).toBeTruthy()
    expect(executeMarketOperation).toHaveBeenCalledWith('tab-install', expect.any(AbortSignal))
    // The page's own install dialog takes a spec and skips the product's private
    // Registry authorization and compatibility checks; the tab never calls it.
    expect(install).not.toHaveBeenCalled()
  })
})
