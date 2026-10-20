/* ====================================================================
 * 插件更新（产品独有）
 * 上游只提供安装、启用/停用和卸载，没有"有新版本"的提示，也没有更新动作。
 * Desktop v2.0.18 起全部包操作走官方插件管理器：它在 hmr 已挂载时拒绝
 * 覆盖安装一个 Profile 已依赖的包（installBundle 的 already-installed），
 * 所以"原地升级"这条路已经不存在。官方插件页自己的更新按钮就是
 * 「先移除已装的包，再安装新版本」（ui-plugin-manager manager-store.ts
 * 的 update()），本覆盖照抄同一语义：两步、非原子，插件自己的配置存在
 * Profile 补丁里，两步都不改写它，选中状态由预览时读到的值还原。
 * 每个导出函数自带锚点守护：上游变动导致锚点失配时装配立即失败。
 * ==================================================================== */
function replace(source, anchor, value) {
  if (source.split(anchor).length !== 2) throw new Error(`market-update: upstream anchor changed: ${anchor}`)
  return source.replace(anchor, value)
}

/** 更新检查与更新动作的主机侧实现。 */
function addUpdatesToHost(service) {
  service = replace(service, "import { prerelease, valid } from 'semver'", "import { gt, prerelease, valid } from 'semver'")
  service = replace(service, 'type MarketIntent = InstallIntent | UninstallIntent', `interface UpdateIntent {
  readonly kind: 'update'
  readonly packageName: string
  readonly version: string
  readonly updateFrom: string
  /** Selection read before the removal and restored by the reinstall. */
  readonly enabled: boolean
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
  readonly authorize: (signal: AbortSignal) => Promise<void>
}

type MarketIntent = InstallIntent | UninstallIntent | UpdateIntent`)
  service = replace(service, 'export type MarketOperationResult =', `export type MarketOperationResult =
  | ({ readonly action: 'update' } & MarketInstallResult)`)
  service = replace(service, '  async executePreview(token:', `  /**
   * The one bundle shape an update applies to: a community package the
   * official manager reports as installed with a readable stable version and
   * allows this surface to remove, because the removal is an update's first
   * step.
   * @throws {MarketInstallError} when the bundle cannot be updated from here.
   */
  private updatableBundle(
    installations: readonly MarketInstallationView[],
    packageName: string,
  ): MarketInstallationView & { readonly version: string } {
    if (!safePackageName(packageName) || !marketManagedPackage(packageName)) {
      throw new MarketInstallError('not-available', 'This package cannot be updated separately.')
    }
    const view = installations.find(item => item.packageName === packageName)
    if (view === undefined || !view.installed || !view.removable) {
      throw new MarketInstallError('not-available', 'This plugin can no longer be updated here. Refresh the installed list.')
    }
    const version = view.version
    if (!stableExactVersion(version)) {
      throw new MarketInstallError('not-available', 'The installed plugin version could not be verified.')
    }
    return { ...view, version }
  }

  /**
   * Annotate the Host inventory with what the authorized catalog offers.
   * A plugin the catalog does not list is never updated from here, so it
   * reports \`unavailable\` rather than a version.
   */
  async checkUpdates(
    installations: readonly MarketInstallationView[],
    allowedPackages: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<readonly MarketInstallationView[]> {
    const profile = this.profile()
    const operationSignal = this.operationSignal(signal)
    // Bounded concurrency avoids one registry request per plugin flooding the network.
    const result: MarketInstallationView[] = []
    for (let offset = 0; offset < installations.length; offset += 4) {
      operationSignal.throwIfAborted()
      result.push(...await Promise.all(installations.slice(offset, offset + 4).map(async item => {
        let current
        try { current = this.updatableBundle(installations, item.packageName) }
        catch { return { ...item, updateStatus: 'unavailable' as const } }
        if (!allowedPackages.has(item.packageName)) return { ...item, updateStatus: 'unavailable' as const }
        try {
          const latest = await this.verifier.verify({ packageName: item.packageName }, operationSignal)
          if (!stableExactVersion(latest.version)) throw new Error('invalid latest')
          return { ...item, updateVersion: latest.version,
            updateStatus: gt(latest.version, current.version) ? 'available' as const : 'current' as const }
        } catch { return { ...item, updateStatus: 'failed' as const } }
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
    const current = this.updatableBundle(await this.listInstallations(operationSignal), packageName)
    const verified = await this.verifier.verify({ packageName }, operationSignal)
    if (!stableExactVersion(verified.version) || !gt(verified.version, current.version)) {
      throw new MarketInstallError('conflict', 'No newer stable version is available. Refresh the installed list.')
    }
    this.sameProfile(profile)
    operationSignal.throwIfAborted()
    const expiresAt = this.now() + this.intentTtlMs
    const intent = this.issueIntent({ kind: 'update', packageName, profile, version: verified.version,
      updateFrom: current.version, enabled: current.enabled, expiresAt, authorize })
    return { intent, action: 'update' as const, packageName, displayName: packageName,
      profileName: profile.name, version: verified.version, updateFrom: current.version,
      expiresAt: new Date(expiresAt).toISOString() }
  }

  async executeUpdate(token: string, signal: AbortSignal): Promise<MarketInstallResult> {
    return await this.runExclusive(async () => {
      const operationSignal = this.operationSignal(signal)
      const intent = this.consumeIntent(token, 'update')
      this.sameProfile(intent.profile)
      await intent.authorize(operationSignal)
      const current = this.updatableBundle(await this.listInstallations(operationSignal), intent.packageName)
      if (current.version !== intent.updateFrom) {
        throw new MarketInstallError('conflict', 'The installed plugin changed after preview. Check for updates again.')
      }
      operationSignal.throwIfAborted()
      // Two steps, like the official Plugins page: the manager has no in-place
      // upgrade, so the installed package is removed and the new version is
      // installed over it. The plugin's own configuration lives in the profile
      // patch, which neither step rewrites; the selection comes from the preview.
      // The pair is not atomic: a removal that fails changes nothing, while an
      // installation that fails leaves the plugin removed, and its message says so.
      await this.runChange(
        () => this.manager.removeBundle(intent.packageName),
        'The plugin could not be removed, so the update did not start and nothing changed.',
      )
      const result = await this.runChange(
        () => this.manager.installBundle(\`\${intent.packageName}@\${intent.version}\`, { enabled: intent.enabled, saveExact: true }),
        'The previous version was removed, but the new one could not be installed. Install the plugin again from the plugin market.',
        failed => failed.bundle === undefined
          ? Promise.resolve(false)
          : this.awaitActivation(failed.bundle, intent.enabled, failed, operationSignal),
      )
      const installed = result.bundle ?? intent.packageName
      if (installed !== intent.packageName) {
        throw this.packageManagerError(
          'The package manager installed a different package than the update target.',
          \`expected \${intent.packageName}, installed \${installed}\`,
        )
      }
      return { packageName: intent.packageName, version: result.version ?? intent.version, application: result.application }
    })
  }

  async executePreview(token:`)
  return replace(service, "    const result: MarketOperationResult = intent.kind === 'install'", `    if (intent.kind === 'update') return { action: 'update', ...await this.executeUpdate(token, signal) }
    const result: MarketOperationResult = intent.kind === 'install'`)
}

/** 更新检查与更新预览的路由。 */
function addUpdatesToRoutes(routes) {
  routes = replace(routes, "  | { readonly action: 'uninstall'; readonly packageName: string }",
    "  | { readonly action: 'uninstall'; readonly packageName: string }\n  | { readonly action: 'update'; readonly packageName: string }")
  routes = replace(routes, `    request.action === 'uninstall'
    && exactKeys(request, ['action', 'packageName'])
    && boundedIdentifier(request.packageName)
  ) return { action: 'uninstall', packageName: request.packageName }`, `    (request.action === 'uninstall' || request.action === 'update')
    && exactKeys(request, ['action', 'packageName'])
    && boundedIdentifier(request.packageName)
  ) return { action: request.action, packageName: request.packageName }`)
  // Update discovery, confirmation and execution always use a freshly authorized
  // catalog: never a catalog cached under another API Key, and never npm itself
  // as a market source.
  routes = replace(routes, '  if (installProvider !== undefined) {\n    routes.push(', `  const updatePackages = async (signal: AbortSignal): Promise<ReadonlySet<string>> => {
    const index = await service.scanCatalog(signal, { force: true })
    if (index === undefined) throw new MarketInstallError('not-available', 'The authorized market catalog is unavailable.')
    return new Set(index.snapshots.flatMap(snapshot => snapshot.items.flatMap(item =>
      item.installSource === undefined && item.package?.registry === 'npm' ? [item.package.name] : [])))
  }
  if (installProvider !== undefined) {
    routes.push(`)
  routes = replace(routes, `          const installations = await install.listInstallations(signal)
          if (!signal.aborted && !res.destroyed) sendJson(res, 200, { installations })`,
  `          let installations = await install.listInstallations(signal)
          if (new URL(req.url ?? '/', 'http://localhost').searchParams.get('updates') === '1') {
            // One bounded scan: a slow catalog degrades the badges, never the list.
            const scanSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)])
            try {
              installations = await install.checkUpdates(installations, await updatePackages(scanSignal), scanSignal)
            } catch {
              installations = installations.map(item => ({ ...item, updateStatus: 'failed' as const }))
            }
          }
          if (!signal.aborted && !res.destroyed) sendJson(res, 200, { installations })`)
  return replace(routes, `          const preview = request.action === 'install'
            ? await install.previewInstall(request.sourceRecordId, request.itemId, signal)
            : await install.previewUninstallPackage(request.packageName, signal)`,
  `          let preview
          if (request.action === 'update') {
            const packageName = request.packageName
            const authorize = async (operationSignal: AbortSignal) => {
              if (!(await updatePackages(operationSignal)).has(packageName)) {
                throw new MarketInstallError('not-available', 'This plugin is no longer available for update in your organization.')
              }
            }
            preview = await install.previewUpdate(packageName, signal, authorize)
          } else if (request.action === 'install') {
            preview = await install.previewInstall(request.sourceRecordId, request.itemId, signal)
          } else {
            preview = await install.previewUninstallPackage(request.packageName, signal)
          }`)
}

/** 已安装清单与详情里的更新角标、更新按钮与确认文案。 */
function addUpdatesToRenderer(settingsTab) {
  // 本地清单先渲染，再去网络查版本；查失败只降级角标，不清空列表。
  settingsTab = replace(settingsTab, '  const loadInstallations = useCallback(async (): Promise<InstallationLoadOutcome | undefined> => {',
    "  const loadInstallations = useCallback(async (checkUpdates = viewRef.current === 'installed'): Promise<InstallationLoadOutcome | undefined> => {")
  settingsTab = replace(settingsTab, `      setInstallations(response.installations)
      setInstallationsLoaded(true)
      setInstallationsUnavailable(false)
      return { installations: response.installations }`, `      setInstallations(response.installations)
      setInstallationsLoaded(true)
      setInstallationsUnavailable(false)
      if (!checkUpdates) return { installations: response.installations }
      try {
        const updates = await readMarketInstallations(request.signal, true)
        if (request.signal.aborted || installationsRequest.current !== request) return
        setInstallations(updates.installations)
        return { installations: updates.installations }
      } catch {
        if (request.signal.aborted || installationsRequest.current !== request) return
        setInstallationsError(t('updateCheckFailed'))
      }
      return { installations: response.installations }`)
  // 详情打开时对已安装插件自动检查一次；失败才显示重试。
  settingsTab = replace(settingsTab, `      if (installation !== undefined) setSelectedInstallation(installation)
      else beginInstallPreview()`, `      if (installation !== undefined) {
        setSelectedInstallation(installation)
        if (installation.removable) void loadInstallations(true)
      } else beginInstallPreview()`)
  settingsTab = replace(settingsTab, `      setInstallations(current => {
        if (result.action === 'install') return current
        return current.filter(installation => installation.packageName !== result.packageName)
      })`, `      setInstallations(current => {
        if (result.action === 'update') return current.map(installation => installation.packageName === result.packageName
          ? { ...installation, version: result.version, updateVersion: result.version, updateStatus: 'current' as const }
          : installation)
        if (result.action === 'install') return current
        return current.filter(installation => installation.packageName !== result.packageName)
      })`)
  settingsTab = replace(settingsTab, "      announce(`${t(result.action === 'install' ? 'installComplete' : 'uninstallComplete')}${applicationHint(result.application)}`)",
    "      announce(`${t(result.action === 'install' ? 'installComplete' : result.action === 'update' ? 'updateComplete' : 'uninstallComplete')}${applicationHint(result.application)}`)")
  settingsTab = replace(settingsTab, `        setOperationError(operationErrorMessage(cause, t(requestValue.action === 'install'
          ? 'previewError'
          : 'uninstallPreviewError')))`, `        setOperationError(operationErrorMessage(cause, t(requestValue.action === 'install'
          ? 'previewError'
          : requestValue.action === 'update'
            ? 'updatePreviewError'
            : 'uninstallPreviewError')))`)
  settingsTab = replace(settingsTab, '            onRetry={() => { setToggleError(undefined); void loadInstallations() }}',
    `            onUpdate={packageName => { void beginOperationPreview({ action: 'update', packageName }) }}
            onRetry={() => { setToggleError(undefined); void loadInstallations() }}`)
  for (const name of ['InstalledView', 'InstallationCard']) {
    const start = settingsTab.indexOf(`function ${name}(`)
    const end = settingsTab.indexOf('\nfunction ', start + 1)
    if (start < 0 || end < 0) throw new Error(`market-update: ${name} boundary changed`)
    let block = settingsTab.slice(start, end)
    block = replace(block, '  onUninstall: (packageName: string) => void',
      '  onUpdate?: ((packageName: string) => void) | undefined\n  onUninstall: (packageName: string) => void')
    if (name === 'InstalledView') {
      block = replace(block, '              onUninstall={props.onUninstall}', '              onUpdate={props.onUpdate}\n              onUninstall={props.onUninstall}')
      block = replace(block, ">{props.t('refresh')}</Button>", ">{props.loading ? props.t('checkingUpdates') : props.t('checkUpdates')}</Button>")
    } else {
      block = replace(block, `          {installation.version !== undefined && <span>{props.t('pluginVersion')}: {installation.version}</span>}`,
        `          {installation.version !== undefined && <span>{props.t('pluginVersion')}: {installation.version}</span>}
          {installation.updateStatus !== undefined && <span>{props.t(installation.updateStatus === 'available'
            ? 'updateAvailable'
            : installation.updateStatus === 'current'
              ? 'upToDate'
              : installation.updateStatus === 'failed' ? 'updateCheckFailed' : 'updateUnavailable')}{installation.updateStatus === 'available' && ' → ' + installation.updateVersion}</span>}`)
      block = replace(block, '      <div className="dshMarketReceiptActions">', `      <div className="dshMarketReceiptActions">
        {installation.updateStatus === 'available' && props.onUpdate !== undefined && <Button
          variant="primary"
          size="sm"
          disabled={props.operationPending || props.toggling}
          aria-label={\`\${props.t('updatePlugin')}: \${packageName}\`}
          onClick={() => props.onUpdate?.(packageName)}
        >{props.t('updatePlugin')}</Button>}`)
    }
    settingsTab = settingsTab.slice(0, start) + block + settingsTab.slice(end)
  }
  // 发现页详情复用原生"已安装"卡片与确认流程，所以更新入口也挂在那里。
  settingsTab = replace(settingsTab, '          installation={selectedInstallation}',
    '          installation={selectedInstallation === undefined ? undefined : matchingInstallation(selected, installations)}')
  settingsTab = replace(settingsTab, '          inventoryLoading={selectedInventoryLoading}',
    '          inventoryLoading={selectedInventoryLoading || (selectedInstallation !== undefined && installationsLoading)}')
  settingsTab = replace(settingsTab, '          inventoryError={selectedInventoryError}',
    '          inventoryError={selectedInventoryError ?? (selectedInstallation === undefined ? undefined : installationsError)}\n          onRetryInventory={() => openItem(selected)}')
  settingsTab = replace(settingsTab, `          onUninstall={packageName => {
            selectedKeyRef.current = undefined
            setSelected(undefined)
            setSelectedInstallation(undefined)
            void beginOperationPreview({ action: 'uninstall', packageName })
          }}`, `          onUpdate={packageName => { void beginOperationPreview({ action: 'update', packageName }) }}
          onUninstall={packageName => { void beginOperationPreview({ action: 'uninstall', packageName }) }}`)
  // 更新确认框开在详情之上：详情只在安装预览时让位。
  settingsTab = replace(settingsTab, '      {selected !== undefined && (',
    "      {selected !== undefined && (operationPreview === undefined || operationPreview.action === 'install') && (")
  settingsTab = replace(settingsTab, '      {selected === undefined && operationPreview !== undefined && (',
    "      {operationPreview !== undefined && (selected === undefined || operationPreview.action !== 'install') && (")
  const detailStart = settingsTab.indexOf('function ItemActionModal(')
  const detailEnd = settingsTab.indexOf('\nfunction ', detailStart + 1)
  if (detailStart < 0) throw new Error('market-update: ItemActionModal boundary changed')
  let detail = settingsTab.slice(detailStart, detailEnd === -1 ? settingsTab.length : detailEnd)
  detail = replace(detail, '  onToggle,\n  onUninstall,\n  t,', '  onToggle,\n  onUninstall,\n  onUpdate,\n  onRetryInventory,\n  t,')
  detail = replace(detail, '  onUninstall: (packageName: string) => void\n  t: MarketSettingsTabProps[\'t\']',
    '  onUninstall: (packageName: string) => void\n  onUpdate?: ((packageName: string) => void) | undefined\n  onRetryInventory?: (() => void) | undefined\n  t: MarketSettingsTabProps[\'t\']')
  detail = replace(detail, `                <span>{inventoryError}</span>
              </div>
            )}`, `                <span>{inventoryError}</span>
                {onRetryInventory !== undefined && <Button variant="outline" size="sm" onClick={onRetryInventory}>{t('retry')}</Button>}
              </div>
            )}`)
  detail = replace(detail, '                  onUninstall={onUninstall}', '                  onUninstall={onUninstall}\n                  onUpdate={onUpdate}')
  // 只有自动检查失败才需要重试入口。
  detail = replace(detail, `                {toggleError !== undefined && <div className="dshMarketError" role="alert">{toggleError}</div>}
              </div>
            )}`, `                {toggleError !== undefined && <div className="dshMarketError" role="alert">{toggleError}</div>}
                {installation.updateStatus === 'failed' && inventoryError === undefined && onRetryInventory !== undefined && <Button
                  variant="outline" size="sm" disabled={pending || inventoryLoading}
                  onClick={onRetryInventory}>{t('retry')}</Button>}
                {operationError !== undefined && <div className="dshMarketError" role="alert">{operationError}</div>}
              </div>
            )}`)
  settingsTab = settingsTab.slice(0, detailStart) + detail + settingsTab.slice(detailEnd === -1 ? settingsTab.length : detailEnd)
  const start = settingsTab.indexOf('function OperationConfirmModal(')
  const end = settingsTab.indexOf('\nfunction ', start + 1)
  if (start < 0 || end < 0) throw new Error('market-update: OperationConfirmModal boundary changed')
  let modal = settingsTab.slice(start, end)
  modal = replace(modal, "  const installing = preview.action === 'install'",
    "  const updating = preview.action === 'update'\n  const installing = preview.action !== 'uninstall'")
  for (const [oldKey, newKey] of [
    ['confirmInstallTitle', 'confirmUpdateTitle'],
    ['confirmInstallBody', 'confirmUpdateBody'],
    ['installing', 'updating'],
    ['confirmInstall', 'confirmUpdate'],
  ]) modal = replace(modal, `t('${oldKey}')`, `(updating ? t('${newKey}') : t('${oldKey}'))`)
  settingsTab = settingsTab.slice(0, start) + modal + settingsTab.slice(end)
  // 确认框里把"当前版本 → 新版本"都摆出来。
  return replace(settingsTab, "      {operation.version !== undefined && <div><dt>{t('exactVersion')}</dt><dd>{operation.version}</dd></div>}",
    "      {operation.updateFrom !== undefined && <div><dt>{t('pluginVersion')}</dt><dd>{operation.updateFrom}</dd></div>}\n      {operation.version !== undefined && <div><dt>{t('exactVersion')}</dt><dd>{operation.version}</dd></div>}")
}

const MESSAGES = {
  zh: {
    checkUpdates: '检查更新',
    checkingUpdates: '正在检查更新…',
    updateAvailable: '可更新',
    upToDate: '无需更新',
    updateCheckFailed: '检查失败，请重试',
    updateUnavailable: '当前市场不可更新',
    updatePlugin: '更新',
    updatePreviewError: '无法确认这个插件还能从当前市场更新，请刷新后重试。',
    confirmUpdateTitle: '确认更新插件',
    confirmUpdateBody: '更新会先卸载当前版本，再安装下面这个版本，插件自己的配置会保留。',
    updating: '正在更新…',
    confirmUpdate: '确认更新',
    updateComplete: '插件更新完成',
  },
  en: {
    checkUpdates: 'Check for updates',
    checkingUpdates: 'Checking for updates…',
    updateAvailable: 'Update available',
    upToDate: 'No update needed',
    updateCheckFailed: 'Update check failed; retry',
    updateUnavailable: 'Update unavailable in this market',
    updatePlugin: 'Update',
    updatePreviewError: 'This plugin can no longer be updated from this market. Refresh and try again.',
    confirmUpdateTitle: 'Confirm plugin update',
    confirmUpdateBody: 'An update uninstalls the current version first, then installs the version below. The plugin keeps its own configuration.',
    updating: 'Updating…',
    confirmUpdate: 'Confirm update',
    updateComplete: 'Plugin updated',
  },
}

export function addMarketUpdates(input) {
  let { service, routes, types, settingsTab, locales } = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.replaceAll('\r\n', '\n')]),
  )
  types = replace(types, `  /** The official manager's error code when it cannot read or load the bundle. */
  readonly error?: string`, `  /** The official manager's error code when it cannot read or load the bundle. */
  readonly error?: string
  /** Product overlay: newest stable version the authorized catalog offers. */
  readonly updateVersion?: string
  /** Product overlay: how this bundle's last update check ended. */
  readonly updateStatus?: 'available' | 'current' | 'unavailable' | 'failed'`)
  types = replace(types, 'export type MarketOperationPreviewRequest =', `export type MarketOperationPreviewRequest =
  | {
      readonly action: 'update'
      /** A removable, catalog-listed package name; the Host re-authorizes it before each step. */
      readonly packageName: string
    }`)
  types = replace(types, "  readonly action: 'install' | 'uninstall'\n  readonly profileName: string",
    "  readonly action: 'install' | 'uninstall' | 'update'\n  readonly updateFrom?: string\n  readonly profileName: string")
  types = replace(types, 'export type MarketOperationExecuteResponse =', `export type MarketOperationExecuteResponse =
  | {
      readonly action: 'update'
      readonly packageName: string
      readonly version: string
      readonly application: MarketOperationApplication
    }`)
  service = addUpdatesToHost(service)
  routes = addUpdatesToRoutes(routes)
  settingsTab = addUpdatesToRenderer(settingsTab)
  for (const [language, entries] of Object.entries(MESSAGES)) {
    const anchor = language === 'zh' ? "  tab: '插件市场'," : "  tab: 'Plugin Market',"
    locales = replace(locales, anchor,
      anchor + '\n' + Object.entries(entries).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join('\n'))
  }
  return { service, routes, types, settingsTab, locales }
}

/** 客户端 API：更新检查用同一个清单端点，多带一个查询参数。 */
export function addMarketUpdateChecks(api) {
  api = replace(api.replaceAll('\r\n', '\n'), 'readMarketInstallations(signal?: AbortSignal)', 'readMarketInstallations(signal?: AbortSignal, updates = false)')
  return replace(api, "fetch('/api/community-market/installations',", "fetch(updates ? '/api/community-market/installations?updates=1' : '/api/community-market/installations',")
}

/** 设置页的更新界面产品回归，追加在上游用例之后。 */
export function addMarketUpdateUiTests(tests) {
  return tests + `
describe('product market update UI', () => {
  const managed = {
    kind: 'profile' as const,
    packageName: '@tokensapi/tool',
    version: '1.9.0',
    enabled: true,
    installed: true,
    toggleable: true,
    removable: true,
  }

  it('renders local inventory while the update lookup is pending and retains it on failure', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    let rejectUpdates!: (error: Error) => void
    // 更新检查就是带 updates 标记的那一次读取。发现页挂载也会先读一次清单给
    // 卡片置灰，所以按参数作答，不按调用次序排夹具。
    vi.mocked(readMarketInstallations).mockImplementation(async (_signal, updates) => {
      if (updates !== true) return { installations: [managed] }
      return await new Promise<never>((_resolve, reject) => { rejectUpdates = reject })
    })
    render(<MarketSettingsTab {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: managed.packageName })).toBeTruthy()
    expect(screen.queryByText(en.loadingInstallations)).toBeNull()
    expect(screen.getByRole('button', { name: en.checkingUpdates })).toBeTruthy()
    expect(readMarketInstallations).toHaveBeenCalledWith(expect.any(AbortSignal), true)
    rejectUpdates(new Error('offline'))
    expect(await screen.findByText(en.updateCheckFailed)).toBeTruthy()
    expect(screen.getByRole('heading', { name: managed.packageName })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.checkUpdates })).toBeTruthy()
  })

  it('shows an available version, confirms explicitly, and keeps the plugin after the update', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    let inventory: readonly import('../src/api-types.js').MarketInstallationView[] = [
      { ...managed, updateVersion: '1.10.0', updateStatus: 'available' },
    ]
    vi.mocked(readMarketInstallations).mockImplementation(async () => ({ installations: inventory }))
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'update', previewId: 'update-token', profileName: 'default',
      packageName: managed.packageName, displayName: managed.packageName, version: '1.10.0', updateFrom: '1.9.0', expiresAt: '2099-01-01' })
    vi.mocked(executeMarketOperation).mockImplementation(async () => {
      // 更新成功之后 Host 报的是新版本、而且已经是最新，更新按钮随之消失。
      inventory = [{ ...managed, version: '1.10.0', updateStatus: 'current' }]
      return { action: 'update', packageName: managed.packageName, version: '1.10.0', application: 'applied' }
    })
    render(<MarketSettingsTab {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.installed }))
    const button = await screen.findByRole('button', { name: \`\${en.updatePlugin}: \${managed.packageName}\` })
    expect(screen.getByText(\`\${en.updateAvailable} → 1.10.0\`)).toBeTruthy()
    expect(executeMarketOperation).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(await screen.findByRole('heading', { name: en.confirmUpdateTitle })).toBeTruthy()
    expect(previewMarketOperation).toHaveBeenCalledWith({ action: 'update', packageName: managed.packageName }, expect.any(AbortSignal))
    // The confirmation names both versions and says the old one is uninstalled first.
    expect(screen.getByText('1.9.0')).toBeTruthy()
    expect(screen.getByText(en.confirmUpdateBody)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmUpdate }))
    expect(await screen.findByText(en.updateComplete)).toBeTruthy()
    expect(screen.getByRole('heading', { name: managed.packageName })).toBeTruthy()
    expect(screen.queryByRole('button', { name: \`\${en.updatePlugin}: \${managed.packageName}\` })).toBeNull()
    expect(screen.getByText(en.upToDate)).toBeTruthy()
  })

  it('offers retry for a failed check and no update button for an unavailable one', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [
      { ...managed, updateStatus: 'failed' },
      { ...managed, packageName: '@tokensapi/other', removable: false, updateStatus: 'unavailable' },
    ] })
    render(<MarketSettingsTab {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.installed }))
    expect(await screen.findByText(en.updateCheckFailed)).toBeTruthy()
    expect(screen.getByText(en.updateUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Update:/u })).toBeNull()
    // 重试要真的再读一次；总次数取决于发现页挂载和进入时的自动检查，不钉死。
    const reads = vi.mocked(readMarketInstallations).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: en.checkUpdates }))
    await waitFor(() => expect(vi.mocked(readMarketInstallations).mock.calls.length).toBeGreaterThan(reads))
  })
})
`
}
