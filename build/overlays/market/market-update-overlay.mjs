// Product-only manual npm upgrades. Fail closed when the pinned upstream drifts.
function replace(source, anchor, value) {
  if (source.split(anchor).length !== 2) throw new Error(`market-update: upstream anchor changed: ${anchor}`)
  return source.replace(anchor, value)
}

export function addMarketUpdates(input) {
  let { service, routes, types, settingsTab, locales } = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.replaceAll('\r\n', '\n')]),
  )
  types = replace(types, "      readonly action: 'uninstall' | 'none'", `      readonly action: 'uninstall' | 'none'
      readonly version?: string
      readonly updateVersion?: string
      readonly updateStatus?: 'available' | 'current' | 'unavailable' | 'failed'`)
  types = replace(types, "export type MarketOperationPreviewRequest =", `export type MarketOperationPreviewRequest =
  | { readonly action: 'update'; readonly bundleId: string }`)
  types = replace(types, "readonly action: 'install' | 'uninstall'", "readonly action: 'install' | 'uninstall' | 'update'\n  readonly updateFrom?: string")
  types = replace(types, "export type MarketOperationExecuteResponse =", `export type MarketOperationExecuteResponse =
  | { readonly action: 'update'; readonly packageName: string; readonly version: string; readonly restartToken: string }`)

  service = replace(service, "import { prerelease, valid } from 'semver'", "import { gt, prerelease, valid, validRange } from 'semver'")
  service = replace(service, '  MarketCatalogMetadata,', '  MarketCatalogMetadata,\n  MarketInstallationView,')
  service = replace(service, 'type MarketIntent = InstallIntent | UninstallIntent', `interface UpdateIntent {
  readonly kind: 'update'
  readonly packageName: string
  readonly version: string
  readonly updateFrom: string
  readonly dependency: string
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
  readonly authorize: (signal: AbortSignal) => Promise<void>
}

type MarketIntent = InstallIntent | UninstallIntent | UpdateIntent`)
  service = replace(service, 'export type MarketOperationResult =', `export type MarketOperationResult =
  | ({ readonly action: 'update'; readonly restartToken: string } & MarketInstallResult)`)
  service = replace(service, '  async executePreview(token:', `  /** Only real, direct npm dependencies are eligible; workspace/Git/file specs are excluded. */
  private async updateState(profile: MarketDesktopProfile, packageName: string) {
    if (!safePackageName(packageName) || !marketManagedPackage(packageName)) {
      throw new MarketInstallError('not-available', 'This package cannot be updated separately.')
    }
    const dependency = await directProfilePluginVersion(profile, packageName)
    if (validRange(dependency) === null) throw new MarketInstallError('not-available', 'Only npm plugins support market updates.')
    const installed = await readManifest(join(profile.dir, 'node_modules', packageName, 'package.json'))
    if (installed.name !== packageName || typeof installed.version !== 'string' || valid(installed.version) !== installed.version) {
      throw new MarketInstallError('not-available', 'The installed plugin version could not be verified.')
    }
    return { dependency, version: installed.version }
  }

  async checkUpdates(
    installations: readonly MarketInstallationView[],
    allowedPackages: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<readonly MarketInstallationView[]> {
    const profile = this.profile()
    const operationSignal = this.operationSignal(signal)
    // Bounded concurrency avoids one npm request per plugin flooding the network.
    const result: MarketInstallationView[] = []
    for (let offset = 0; offset < installations.length; offset += 4) {
      operationSignal.throwIfAborted()
      result.push(...await Promise.all(installations.slice(offset, offset + 4).map(async item => {
        if (item.action !== 'uninstall') return item
        let state
        try { state = await this.updateState(profile, item.packageName) }
        catch { return { ...item, updateStatus: 'unavailable' as const } }
        if (!allowedPackages.has(item.packageName)) return { ...item, version: state.version, updateStatus: 'unavailable' as const }
        try {
          const latest = await this.verifier.verify({ packageName: item.packageName }, operationSignal)
          if (!stableExactVersion(latest.version)) throw new Error('invalid latest')
          return { ...item, version: state.version, updateVersion: latest.version,
            updateStatus: gt(latest.version, state.version) ? 'available' as const : 'current' as const }
        } catch { return { ...item, version: state.version, updateStatus: 'failed' as const } }
      })))
    }
    operationSignal.throwIfAborted()
    this.sameProfile(profile)
    return result
  }

  async previewUpdate(packageName: string, signal: AbortSignal, authorize: (signal: AbortSignal) => Promise<void>) {
    const operationSignal = this.operationSignal(signal)
    const profile = this.profile()
    await authorize(operationSignal)
    const state = await this.updateState(profile, packageName)
    const verified = await this.verifier.verify({ packageName }, operationSignal)
    if (!stableExactVersion(verified.version) || !gt(verified.version, state.version)) {
      throw new MarketInstallError('conflict', 'No newer stable npm version is available. Refresh the installed list.')
    }
    this.sameProfile(profile)
    operationSignal.throwIfAborted()
    const expiresAt = this.now() + this.intentTtlMs
    const intent = this.issueIntent({ kind: 'update', packageName, profile, version: verified.version,
      updateFrom: state.version, dependency: state.dependency, expiresAt, authorize })
    return { intent, action: 'update' as const, packageName, displayName: packageName,
      profileName: profile.name, version: verified.version, updateFrom: state.version,
      expiresAt: new Date(expiresAt).toISOString() }
  }

  async executeUpdate(token: string, signal: AbortSignal): Promise<MarketInstallResult> {
    return await this.runExclusive(async () => {
      const operationSignal = this.operationSignal(signal)
      const intent = this.consumeIntent(token, 'update')
      const profile = this.sameProfile(intent.profile)
      await intent.authorize(operationSignal)
      const state = await this.updateState(profile, intent.packageName)
      if (state.version !== intent.updateFrom || state.dependency !== intent.dependency) {
        throw new MarketInstallError('conflict', 'The installed plugin changed after preview. Check for updates again.')
      }
      this.sameProfile(profile)
      operationSignal.throwIfAborted()
      // No uninstall and no bundle/settings rewrite: preserve plugin configuration and enable state.
      await this.runPnpm(['add', ...this.installOptions(intent.packageName),
        intent.packageName + '@' + intent.version], operationSignal)
      try {
        const installed = await this.updateState(profile, intent.packageName)
        if (installed.version !== intent.version || installed.dependency !== intent.version) throw new Error('version mismatch')
      } catch {
        throw new MarketInstallError('operation-failed', 'The package manager changed the Profile, but the update could not be validated. Use a Recovery checkpoint to restore the previous Profile state.')
      }
      return { packageName: intent.packageName, version: intent.version }
    })
  }

  async executePreview(token:`)
  service = replace(service, "    const result: MarketOperationResult = intent.kind === 'install'", `    if (intent.kind === 'update') {
      return { action: 'update', ...await this.executeUpdate(token, signal), restartToken: this.issueRestartToken() }
    }
    const result: MarketOperationResult = intent.kind === 'install'`)

  routes = replace(routes, 'type MarketOperationPreviewRequest =', "type MarketOperationPreviewRequest =\n  | { readonly action: 'update'; readonly bundleId: string }")
  routes = replace(routes, "    request.action === 'uninstall'\n    && exactKeys", "    (request.action === 'uninstall' || request.action === 'update')\n    && exactKeys")
  routes = replace(routes, ") return { action: 'uninstall', bundleId: request.bundleId }", ") return { action: request.action, bundleId: request.bundleId }")
  // Always use a fresh authorized catalog for update discovery/confirmation/execution.
  // Never reuse a catalog cached under another API Key, and never enumerate npm as a market source.
  routes = replace(routes, '  if (installProvider !== undefined) {\n    routes.push(', `  const updatePackages = async (signal: AbortSignal): Promise<ReadonlySet<string>> => {
    const index = await service.scanCatalog(signal, { force: true })
    if (index === undefined) throw new MarketInstallError('not-available', 'The authorized market catalog is unavailable.')
    return new Set(index.snapshots.flatMap(snapshot => snapshot.items.flatMap(item =>
      item.installSource === undefined && item.package?.registry === 'npm' ? [item.package.name] : [])))
  }
  if (installProvider !== undefined) {
    routes.push(`)
  routes = replace(routes, '          const installations = reconcileInstallations(desktopPlugins.list())', `          let installations = reconcileInstallations(desktopPlugins.list())
          if (new URL(req.url ?? '/', 'http://localhost').searchParams.get('updates') === '1') {
            const signal = AbortSignal.any([generationController.signal, AbortSignal.timeout(15000)])
            try {
              const install = installProvider.get()
              if (install === undefined) throw new Error('install service unavailable')
              installations = await install.checkUpdates(installations, await updatePackages(signal), signal)
            } catch {
              installations = installations.map(item => item.action === 'none' ? item : { ...item, updateStatus: 'failed' as const })
            }
          }`)
  routes = replace(routes, "          if (request.action === 'install') {\n            preview", `          if (request.action === 'update') {
            const target = desktopPluginsProvider?.get()?.list().find(bundle => bundle.bundleId === request.bundleId)
            if (target === undefined || !target.mutable || !target.uninstallable) {
              throw new MarketInstallError('not-available', 'This plugin cannot be updated separately.')
            }
            const authorize = async (operationSignal: AbortSignal) => {
              const packages = await updatePackages(operationSignal)
              const current = desktopPluginsProvider?.get()?.list().find(bundle => bundle.bundleId === request.bundleId)
              if (current?.packageName !== target.packageName || !current.mutable || !current.uninstallable || !packages.has(target.packageName)) {
                throw new MarketInstallError('not-available', 'This plugin is no longer available for update in your organization.')
              }
            }
            preview = await install.previewUpdate(target.packageName, signal, authorize)
          } else if (request.action === 'install') {
            preview`)

  // Keep the existing JSON API and confirmation/restart flow; update is an explicit action.
  settingsTab = replace(settingsTab, "      void loadInstallable(false, '', [])\n    } else {", "      void loadInstallable(false, '', [])\n    } else if (viewRef.current === 'installed') {\n      void loadState('', [], false, false)\n      void loadInstallations()\n    } else {")
  settingsTab = replace(settingsTab, '  }, [loadInstallable, loadState])', '  }, [loadInstallable, loadInstallations, loadState])')
  settingsTab = replace(settingsTab, "        if (result.action === 'install') return current", `        if (result.action === 'update') return current.map(item => item.packageName === result.packageName
          ? { ...item, version: result.version, updateVersion: result.version, updateStatus: 'current' as const } : item)
        if (result.action === 'install') return current`)
  settingsTab = replace(settingsTab, "t(requestValue.action === 'install'", "t(requestValue.action !== 'uninstall'")
  settingsTab = replace(settingsTab, "            onRetry={() => { void loadInstallations() }}", `            onUpdate={bundleId => { void beginOperationPreview({ action: 'update', bundleId }) }}
            onRetry={() => { void loadInstallations() }}`)
  for (const name of ['InstalledView', 'InstallationCard']) {
    const start = settingsTab.indexOf(`function ${name}(`)
    const end = settingsTab.indexOf('\nfunction ', start + 1)
    let block = settingsTab.slice(start, end)
    block = replace(block, '  onUninstall: (bundleId: string) => void', '  onUpdate?: ((bundleId: string) => void) | undefined\n  onUninstall: (bundleId: string) => void')
    if (name === 'InstalledView') {
      block = block.replaceAll('              onUninstall={props.onUninstall}', '              onUpdate={props.onUpdate}\n              onUninstall={props.onUninstall}')
      block = replace(block, ">{props.t('refresh')}</Button>", ">{props.loading ? props.t('checkingUpdates') : props.t('checkUpdates')}</Button>")
    } else {
      block = replace(block, '          <span>{packageName}</span>', `          <span>{packageName}</span>
          {installation.version !== undefined && <span>{props.t('installedVersion')}: {installation.version}</span>}
          {installation.updateStatus !== undefined && <span>{props.t(installation.updateStatus === 'available' ? 'updateAvailable' : installation.updateStatus === 'current' ? 'upToDate' : installation.updateStatus === 'failed' ? 'updateCheckFailed' : 'updateUnavailable')}{installation.updateStatus === 'available' && ' → ' + installation.updateVersion}</span>}`)
      block = replace(block, '      <div className="dshMarketReceiptActions">', `      <div className="dshMarketReceiptActions">
        {installation.action === 'uninstall' && installation.updateStatus === 'available' && props.onUpdate && <Button
          variant="primary" size="sm" disabled={props.operationPending}
          aria-label={props.t('updatePlugin') + ': ' + displayName}
          onClick={() => props.onUpdate?.(installation.bundleId)}>{props.t('updatePlugin')}</Button>}`)
    }
    settingsTab = settingsTab.slice(0, start) + block + settingsTab.slice(end)
  }
  settingsTab = replace(settingsTab, "  const installing = preview.action === 'install'", "  const updating = preview.action === 'update'\n  const installing = preview.action !== 'uninstall'")
  const start = settingsTab.indexOf('function OperationConfirmModal(')
  const end = settingsTab.indexOf('\nfunction OperationSuccessModal', start)
  let modal = settingsTab.slice(start, end)
  for (const [oldKey, newKey] of [['confirmInstallTitle', 'confirmUpdateTitle'], ['confirmInstallBody', 'confirmUpdateBody'], ['installing', 'updating'], ['confirmInstall', 'confirmUpdate']]) {
    modal = replace(modal, `t('${oldKey}')`, `(updating ? t('${newKey}') : t('${oldKey}'))`)
  }
  settingsTab = settingsTab.slice(0, start) + modal + settingsTab.slice(end)
  settingsTab = replace(settingsTab, "  const title = operation.preview.action === 'install'", "  const title = operation.preview.action === 'update' ? t('updateComplete') : operation.preview.action === 'install'")
  settingsTab = replace(settingsTab, "      {operation.version !== undefined &&", "      {operation.updateFrom !== undefined && <div><dt>{t('installedVersion')}</dt><dd>{operation.updateFrom}</dd></div>}\n      {operation.version !== undefined &&")
  const messages = {
    zh: { checkUpdates: '检查更新', checkingUpdates: '正在检查更新…', installedVersion: '已安装版本', updateAvailable: '可更新', upToDate: '无需更新', updateCheckFailed: '检查失败，请重试', updateUnavailable: '当前市场不可更新', updatePlugin: '更新', confirmUpdateTitle: '确认更新插件', confirmUpdateBody: '将插件更新至以下版本，保留现有配置。完成后需要重启应用。', updating: '正在更新…', confirmUpdate: '确认更新', updateComplete: '插件更新完成' },
    en: { checkUpdates: 'Check for updates', checkingUpdates: 'Checking for updates…', installedVersion: 'Installed version', updateAvailable: 'Update available', upToDate: 'No update needed', updateCheckFailed: 'Update check failed; retry', updateUnavailable: 'Update unavailable in this market', updatePlugin: 'Update', confirmUpdateTitle: 'Confirm plugin update', confirmUpdateBody: 'Update to the version below, keeping existing configuration. Restart the app when finished.', updating: 'Updating…', confirmUpdate: 'Confirm update', updateComplete: 'Plugin updated' },
  }
  for (const [lang, entries] of Object.entries(messages)) {
    const anchor = lang === 'zh' ? "  tab: '插件市场'," : "  tab: 'Plugin Market',"
    locales = replace(locales, anchor, anchor + '\n' + Object.entries(entries).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join('\n'))
  }
  return { service, routes, types, settingsTab, locales }
}

export function addMarketUpdateChecks(api) {
  return replace(api.replaceAll('\r\n', '\n'), "fetch('/api/community-market/installations',", "fetch('/api/community-market/installations?updates=1',")
}

export function addMarketUpdateApiTests(tests) {
  return replace(tests, "toBe('/api/community-market/installations')", "toBe('/api/community-market/installations?updates=1')")
}

export function addMarketUpdateUiTests(tests) {
  return tests + `
describe('product market update UI', () => {
  it('shows an available version, confirms explicitly, and keeps the plugin after update', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [{
      kind: 'profile', bundleId: 'update-fixture', packageName: '@tokensapi/tool', status: 'disabled', action: 'uninstall',
      version: '1.9.0', updateVersion: '1.10.0', updateStatus: 'available',
    }] })
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'update', previewId: 'update-token', profileName: 'default',
      packageName: '@tokensapi/tool', displayName: '@tokensapi/tool', version: '1.10.0', updateFrom: '1.9.0', expiresAt: '2099-01-01' })
    vi.mocked(executeMarketOperation).mockResolvedValue({ action: 'update', packageName: '@tokensapi/tool', version: '1.10.0', restartToken: 'restart' })
    render(<MarketSettingsTab {...props} initialView="installed" />)
    const button = await screen.findByRole('button', { name: en.updatePlugin + ': @tokensapi/tool' })
    expect(screen.getByText(en.updateAvailable + ' → 1.10.0')).toBeTruthy()
    expect(executeMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(await screen.findByRole('heading', { name: en.confirmUpdateTitle })).toBeTruthy()
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'update', bundleId: 'update-fixture' }, expect.any(AbortSignal))
    expect(screen.getByText('1.9.0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmUpdate }))
    expect(await screen.findByRole('heading', { name: en.updateComplete })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.restartLater }))
    expect(screen.getByRole('heading', { name: '@tokensapi/tool' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.updatePlugin + ': @tokensapi/tool' })).toBeNull()
    expect(screen.getByText(en.upToDate)).toBeTruthy()
    expect(screen.getByText(en.disabledPlugin)).toBeTruthy()
  })
  it('offers retry for failed checks and no update button for system components', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [
      { kind: 'profile', bundleId: 'fail', packageName: '@tokensapi/tool', status: 'active', action: 'uninstall', updateStatus: 'failed' },
      { kind: 'profile', bundleId: 'core', packageName: 'dsh-plugin-desktop', status: 'active', action: 'none' },
    ] })
    render(<MarketSettingsTab {...props} initialView="installed" />)
    expect(await screen.findByText(en.updateCheckFailed)).toBeTruthy()
    const pluginCard = screen.getByRole('heading', { name: '@tokensapi/tool' }).closest('.dshMarketReceipt')
    const coreCard = screen.getByRole('heading', { name: 'dsh-plugin-desktop' }).closest('.dshMarketReceipt')
    expect(pluginCard?.parentElement).toBe(coreCard?.parentElement)
    expect(document.querySelectorAll('.dshMarketReceipts')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: en.uninstall + ': dsh-plugin-desktop' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Update:/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.checkUpdates }))
    await waitFor(() => expect(readMarketInstallations).toHaveBeenCalledTimes(2))
  })
})
`
}
