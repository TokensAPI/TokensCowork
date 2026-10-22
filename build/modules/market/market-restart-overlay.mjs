/* ====================================================================
 * 更新后的重启提示（产品独有）
 *
 * Desktop 2.0.18 起包操作由官方插件管理器即时应用，但「即时」只对插件
 * 自己的模块成立：插件依赖的共享模块（真机上是 undici）若在本进程里已经
 * 加载，宿主 HMR 就以 module-comparison 为由沿用旧代码，只打一条 warn
 * （`[hmr] changed modules keep running their previous code until a
 * restart`），运行中的插件实际跑在「新代码 + 旧依赖」上——连接中心
 * 2.9.6 → 2.9.7 热更新后微信入站仍按旧版失败，重启才好（T0048）。
 *
 * 宿主其实已经把这件事报出来了：plugin-manager 的 reload() 拿 HMR 的
 * reconcileProfile() 结果，pending/restartReason 非空就把 ChangeResult
 * 的 application 改成 'restart-required' 并带上 restartReason。市场的
 * runChange() 收得到，但只把它变成一条几秒就消失的 Toast 文案
 * （`restartHint`），既没说是哪个插件，也没有重启入口。
 *
 * 本覆盖把这条已有信号接到界面上：
 *   1. 服务端把 restartReason 一起回给渲染层（原本在 runChange 之后被丢掉）；
 *   2. 桌面动作多一个 restart 端点，转调宿主已有的 desktopActions.requestRestart()；
 *   3. 渲染层把「待重启」记在模块作用域，面板顶部常驻横幅，列出待重启的插件、
 *      说明是共享依赖没换掉，并提供「立即重启」。
 * 没有该信号时（application === 'applied'）一切照旧，不提示。
 *
 * 每个导出函数自带锚点守护：上游变动导致锚点失配时装配立即失败。
 * ==================================================================== */
import { AnchorError, insertAfter, insertBefore, replaceOnce } from '../../pipeline/anchors.mjs'

const LABEL = 'market-restart'

/** 宿主 plugin-manager 的 RestartReason 取值；与固定上游逐字一致，由用例守住。 */
export const RESTART_REASONS = ['no-hmr', 'package-moved', 'host-module', 'unmanaged-plugin', 'module-comparison']

/** 共享模块没换掉这两种原因才说「共享依赖」，其余只说「保存了，重启后生效」。 */
export const SHARED_MODULE_REASONS = ['module-comparison', 'host-module']

/** 桌面重启端点；与上游 open-terminal 同一前缀。 */
export const RESTART_ROUTE = '/api/community-market/desktop/restart'

/** 按出现次数守护的整体替换：上游多出或少掉一处响应形状时装配失败。 */
function replaceEach(source, pattern, times, replacer) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== times) {
    throw new AnchorError(`${LABEL}：锚点应命中 ${times} 次，实际 ${matches.length} 次：/${pattern.source.slice(0, 60)}/`)
  }
  return source.replace(pattern, replacer)
}

/** 渲染层契约：重启原因，以及每个完成响应带回的 restartReason。 */
function reportRestartReason(types) {
  types = replaceOnce(types, `export type MarketOperationApplication = 'applied' | 'restart-required' | 'overridden'`,
    `export type MarketOperationApplication = 'applied' | 'restart-required' | 'overridden'

/**
 * Product overlay: why the official plugin manager says a completed change only
 * takes effect at the next start. Same values as the manager's own
 * \`RestartReason\`; \`module-comparison\` and \`host-module\` mean modules the change
 * replaced on disk are already loaded, so the Host keeps running the old code.
 */
export type MarketRestartReason = ${RESTART_REASONS.map(reason => `'${reason}'`).join(' | ')}`, LABEL)
  types = replaceOnce(types, `  readonly desktopActions: {
    readonly openTerminal: boolean
  }`, `  /**
   * Product overlay: completed changes the Host saved but cannot apply before a
   * restart. Read from the Host rather than remembered by the renderer: the
   * market surface remounts whenever the user moves between the sidebar panel
   * and the Plugins page, and the warning has to outlive that. Optional so that
   * a state fixture or an older Host without it still reads as "nothing pending"
   * instead of failing the whole surface.
   */
  readonly pendingRestarts?: readonly MarketPendingRestart[]
  readonly desktopActions: {
    readonly openTerminal: boolean
    /** Product overlay: whether this Host can restart the application on request. */
    readonly restart?: boolean
  }`, LABEL)
  types = replaceOnce(types, 'export interface MarketStateResponse {',
    `/** Product overlay: one completed change that only takes effect at the next start. */
export interface MarketPendingRestart {
  readonly packageName: string
  readonly reason?: MarketRestartReason
}

export interface MarketStateResponse {`, LABEL)
  // 安装、更新、卸载、启停四种完成响应各带一个 application，逐个补上原因。
  return replaceEach(types, /([ \t]*)readonly application: MarketOperationApplication\n/gu, 4,
    (match, indent) => `${match}${indent}readonly restartReason?: MarketRestartReason\n`)
}

/** 服务端：把官方管理器的 restartReason 透传给路由，而不是在 runChange 之后丢掉。 */
function keepRestartReason(service) {
  service = replaceOnce(service, `import type {
  MarketCatalogMetadata,`, `import type {
  MarketCatalogMetadata,
  MarketPendingRestart,
  MarketRestartReason,`, LABEL)
  service = replaceEach(service, /([ \t]*)readonly application: MarketOperationApplication\n/gu, 3,
    (match, indent) => `${match}${indent}readonly restartReason?: MarketRestartReason\n`)
  service = replaceOnce(service, '  private readonly intents = new Map<string, MarketIntent>()',
    `  private readonly intents = new Map<string, MarketIntent>()
  /** Product overlay: packages whose last completed change waits for a restart, with the manager's reason. */
  private readonly pendingRestarts = new Map<string, MarketRestartReason | undefined>()`, LABEL)
  service = replaceOnce(service, `    this.candidates.clear()
    this.intents.clear()`, `    this.candidates.clear()
    this.intents.clear()
    this.pendingRestarts.clear()`, LABEL)
  // 官方管理器只在 restart-required 时保留 restartReason（change() 里其余分支删掉它），
  // 这里照同一口径再判一次，免得将来上游放宽时把一个陈旧原因带给界面。
  service = replaceOnce(service, '  private async runChange(', `  /**
   * Product overlay: record one completed change the Host could not apply, and
   * report its reason back to the caller.
   *
   * The official manager says so exactly once, in the response to the change
   * itself, so the Profile's service is where it can be remembered: a renderer
   * that remounts — moving between the sidebar panel and the Plugins page — asks
   * the Host again instead of losing the warning.
   * @returns The manager's reason, when it gave one.
   */
  private restartFacts(
    packageName: string,
    result: { readonly application: MarketOperationApplication; readonly restartReason?: MarketRestartReason },
  ): { readonly restartReason?: MarketRestartReason } {
    if (result.application !== 'restart-required') return {}
    this.pendingRestarts.set(packageName, result.restartReason)
    return result.restartReason === undefined ? {} : { restartReason: result.restartReason }
  }

  /** Product overlay: every change this profile saved but cannot apply before a restart. */
  listPendingRestarts(): readonly MarketPendingRestart[] {
    return [...this.pendingRestarts].map(([packageName, reason]) =>
      reason === undefined ? { packageName } : { packageName, reason })
  }

  private async runChange(`, LABEL)
  for (const [anchor, name] of [
    ['return { packageName, version: result.version ?? verification.version, application: result.application }', 'packageName'],
    ['return { packageName: intent.packageName, version: result.version ?? intent.version, application: result.application }', 'intent.packageName'],
    ['return { packageName: intent.packageName, application: result.application }', 'intent.packageName'],
    ['return { packageName, enabled, application: result.application }', 'packageName'],
  ]) service = replaceOnce(service, anchor, `${anchor.slice(0, -2)}, ...this.restartFacts(${name}, result) }`, LABEL)
  return service
}

/** 路由：桌面动作多一个重启端点，状态响应报告它是否可用。 */
function addRestartRoute(routes) {
  routes = replaceOnce(routes, `const ROUTE_OPEN_TERMINAL = '/api/community-market/desktop/open-terminal'`,
    `const ROUTE_OPEN_TERMINAL = '/api/community-market/desktop/open-terminal'
const ROUTE_RESTART = '${RESTART_ROUTE}'`, LABEL)
  routes = replaceOnce(routes, `export interface MarketDesktopActions {
  openTerminal?(): void
}`, `export interface MarketDesktopActions {
  openTerminal?(): void
  /** Product overlay: the Host-owned orderly application restart. */
  requestRestart?(): Promise<void>
}`, LABEL)
  routes = replaceOnce(routes, `            openTerminal: typeof desktopActions?.openTerminal === 'function',`,
    `            openTerminal: typeof desktopActions?.openTerminal === 'function',
            restart: typeof desktopActions?.requestRestart === 'function',`, LABEL)
  // 待重启清单跟着状态走：渲染层每次挂载都重新问宿主，不自己记。
  routes = replaceOnce(routes, `          builtIns: viewBuiltIns(),`,
    `          builtIns: viewBuiltIns(),
          pendingRestarts: installProvider?.get()?.listPendingRestarts() ?? [],`, LABEL)
  routes = replaceOnce(routes, `  openTerminal: ROUTE_OPEN_TERMINAL,`,
    `  openTerminal: ROUTE_OPEN_TERMINAL,
  restart: ROUTE_RESTART,`, LABEL)
  // 与上游开终端同一个 desktopActionsProvider 守卫内，排在它后面。
  // 重启确认是一个原生对话框，确认后进程就走了：必须先把回执冲出去再排队，
  // 否则渲染层拿不到响应，按钮会一直停在「正在重启…」。
  return insertAfter(routes, `          actions.openTerminal()
          if (!signal.aborted && !res.destroyed) sendJson(res, 200, { ok: true })
        } catch (cause) {
          if (!signal.aborted && !res.destroyed) sendInstallError(res, cause)
        } finally {
          stopWatching()
        }
      }}),
`, `      ctx.webServer.register({ kind: 'exact', path: ROUTE_RESTART, handler: async (req, res) => {
        if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
          sendJson(res, 405, { error: 'restarting requires a local same-origin POST' })
          return
        }
        const actions = desktopActionsProvider.get()
        const requestRestart = actions?.requestRestart
        if (requestRestart === undefined) {
          sendJson(res, 503, { error: 'desktop actions are unavailable' })
          return
        }
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, generationController.signal])
        const stopWatching = abortOnDisconnect(req, res, controller)
        try {
          asEmptyDesktopAction(await readOperationJson(req, signal))
          signal.throwIfAborted()
          if (res.destroyed) return
          sendJson(res, 200, { ok: true })
          // The relaunch asks the user to confirm and then ends the process, so
          // the acknowledgement is flushed before the action is queued.
          const queue = () => {
            void Promise.resolve(requestRestart.call(actions)).catch((cause: unknown) => {
              ctx.logger.error(\`dsh-community-market: the requested restart failed: \${
                cause instanceof Error ? cause.message : String(cause)
              }\`)
            })
          }
          if (res.writableFinished) queue()
          else res.once('finish', queue)
        } catch (cause) {
          if (!signal.aborted && !res.destroyed) sendInstallError(res, cause)
        } finally {
          stopWatching()
        }
      }}),
`, LABEL)
}

/** 市场插件自己声明的桌面能力：补上重启。 */
function acceptRestartCapability(index) {
  return replaceOnce(index, `interface DesktopActionsCapability {
  openTerminal?(): void
}`, `interface DesktopActionsCapability {
  openTerminal?(): void
  requestRestart?(): Promise<void>
}`, LABEL)
}

/** 客户端 API：重启调用。 */
export function addMarketRestartCall(api) {
  return insertBefore(api.replaceAll('\r\n', '\n'), `export async function setMarketInstallationEnabled(`,
    `export async function requestMarketRestart(signal?: AbortSignal): Promise<MarketDesktopActionResponse> {
  return await readJson(await fetch('${RESTART_ROUTE}', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    ...(signal === undefined ? {} : { signal }),
  }))
}

`, LABEL)
}

/** 面板顶部的常驻重启横幅。 */
function addRestartBanner(settingsTab) {
  settingsTab = replaceOnce(settingsTab, `  MarketOperationApplication,`, `  MarketOperationApplication,
  MarketPendingRestart,
  MarketRestartReason,`, LABEL)
  settingsTab = replaceOnce(settingsTab, `  readMoreMarketCatalog,`, `  readMoreMarketCatalog,
  requestMarketRestart,`, LABEL)
  settingsTab = replaceOnce(settingsTab, `/** A completed package change, announced once as a transient banner. */`,
    `/** Whether any pending change is one the Host could not hot-swap, not merely one it saved. */
function sharedModulesPending(pending: readonly MarketPendingRestart[]): boolean {
  return pending.some(entry => entry.reason !== undefined && ${JSON.stringify(SHARED_MODULE_REASONS)}.includes(entry.reason))
}

/** Add one change to the pending list without losing what the Host already reported. */
function withPendingRestart(
  pending: readonly MarketPendingRestart[],
  packageName: string,
  reason?: MarketRestartReason,
): readonly MarketPendingRestart[] {
  const entry = reason === undefined ? { packageName } : { packageName, reason }
  return [...pending.filter(item => item.packageName !== packageName), entry]
}

/** A completed package change, announced once as a transient banner. */`, LABEL)
  settingsTab = replaceOnce(settingsTab, `  const [desktopActionError, setDesktopActionError] = useState<string>()`,
    `  const [restartPending, setRestartPending] = useState<readonly MarketPendingRestart[]>([])
  const [restartError, setRestartError] = useState<string>()
  const [restartRequesting, setRestartRequesting] = useState(false)
  const restartRequest = useRef<AbortController>()
  const [desktopActionError, setDesktopActionError] = useState<string>()`, LABEL)
  // 挂载时按宿主报的清单起步：换标签页重新挂载也还看得到上一次的待重启。
  settingsTab = replaceOnce(settingsTab, `      const next = await readMarketState(request.signal)
      if (request.signal.aborted || readRequest.current !== request) return
      setState(next)`, `      const next = await readMarketState(request.signal)
      if (request.signal.aborted || readRequest.current !== request) return
      setState(next)
      setRestartPending(next.pendingRestarts ?? [])`, LABEL)
  settingsTab = replaceOnce(settingsTab, `        desktopActions: state?.desktopActions ?? { openTerminal: false },`,
    `        pendingRestarts: state?.pendingRestarts ?? [],
        desktopActions: state?.desktopActions ?? { openTerminal: false },`, LABEL)
  // 安装、更新、卸载与启停四条完成路径共用同一个记录点，紧跟各自的完成提示。
  settingsTab = replaceOnce(settingsTab, `  const applicationHint = (application: MarketOperationApplication): string =>`,
    `  const notePendingRestart = (
    packageName: string,
    application: MarketOperationApplication,
    reason?: MarketRestartReason,
  ): void => {
    if (application !== 'restart-required') return
    setRestartPending(current => withPendingRestart(current, packageName, reason))
  }

  /**
   * Ask the Host for an orderly restart. The Host acknowledges before it asks the
   * user to confirm, so a resolved request means the prompt is up, not that the
   * application is going down: the banner stays and the button becomes usable
   * again, which is also what the user needs after cancelling the prompt.
   */
  const restartNow = async () => {
    if (restartRequest.current !== undefined) return
    const request = new AbortController()
    restartRequest.current = request
    setRestartRequesting(true)
    setRestartError(undefined)
    try {
      await requestMarketRestart(request.signal)
    } catch (cause) {
      if (request.signal.aborted || restartRequest.current !== request) return
      setRestartError(t(isDesktopUnavailable(cause) ? 'restartUnavailable' : 'restartFailed'))
    } finally {
      if (restartRequest.current === request) {
        restartRequest.current = undefined
        setRestartRequesting(false)
      }
    }
  }

  const applicationHint = (application: MarketOperationApplication): string =>`, LABEL)
  settingsTab = replaceOnce(settingsTab,
    "      announce(`${t(result.action === 'install' ? 'installComplete' : result.action === 'update' ? 'updateComplete' : 'uninstallComplete')}${applicationHint(result.application)}`)",
    "      announce(`${t(result.action === 'install' ? 'installComplete' : result.action === 'update' ? 'updateComplete' : 'uninstallComplete')}${applicationHint(result.application)}`)\n"
    + '      notePendingRestart(result.packageName, result.application, result.restartReason)', LABEL)
  settingsTab = replaceOnce(settingsTab,
    "      announce(`${t(result.enabled ? 'enableComplete' : 'disableComplete')}${applicationHint(result.application)}`)",
    "      announce(`${t(result.enabled ? 'enableComplete' : 'disableComplete')}${applicationHint(result.application)}`)\n"
    + '      notePendingRestart(result.packageName, result.application, result.restartReason)', LABEL)
  // 横幅在视图栏之前：插件页的「发现」标签不渲染视图栏，这一格也要看得到。
  settingsTab = replaceOnce(settingsTab, `      {showViewBar && (<div className="dshMarketViewBar">`,
    `      {restartPending.length > 0 && (
        <div className="dshMarketBanner dshMarketRestartBanner" role="status">
          <div className="dshMarketRestartBannerText">
            <strong>{t('restartBannerTitle')}</strong>
            <span>{t(sharedModulesPending(restartPending) ? 'restartBannerShared' : 'restartBannerGeneric')}</span>
            <span className="dshMarketRestartBannerPlugins">
              {t('restartBannerPlugins')}: {restartPending.map(entry => entry.packageName).join(', ')}
            </span>
            {restartError !== undefined && <div className="dshMarketError" role="alert">{restartError}</div>}
          </div>
          {canRestart && (
            <Button variant="primary" disabled={restartRequesting} onClick={() => { void restartNow() }}>
              {restartRequesting ? t('restarting') : t('restartNow')}
            </Button>
          )}
        </div>
      )}
      {showViewBar && (<div className="dshMarketViewBar">`, LABEL)
  // canRestart 与上游 canOpenTerminal 同一来源：Host 报告这台机器有没有这个动作。
  return replaceOnce(settingsTab, `  const announce = (text: string) => {`,
    `  const canRestart = state?.desktopActions.restart === true

  const announce = (text: string) => {`, LABEL)
}

const MESSAGES = {
  zh: {
    restartBannerTitle: '需要重启才能完全生效',
    restartBannerShared: '这次变更换掉了插件依赖的共享模块，而这些模块在本次运行中已经加载，宿主会继续用旧代码，重启 DSH Desktop 后才完全生效。',
    restartBannerGeneric: '这次变更已经保存，重启 DSH Desktop 后才完全生效。',
    restartBannerPlugins: '涉及插件',
    restartNow: '立即重启',
    restarting: '正在重启…',
    restartFailed: '未能发起重启，请手动退出后重新打开。',
    restartUnavailable: '这里无法发起重启，请手动退出后重新打开。',
  },
  en: {
    restartBannerTitle: 'A restart is needed to finish applying this change',
    restartBannerShared: 'This change replaced shared modules the plugin depends on. They were already loaded in this run, so the Host keeps running their previous code until DSH Desktop restarts.',
    restartBannerGeneric: 'The change is saved and takes effect after DSH Desktop restarts.',
    restartBannerPlugins: 'Plugins',
    restartNow: 'Restart now',
    restarting: 'Restarting…',
    restartFailed: 'The restart could not be started. Quit the app and open it again.',
    restartUnavailable: 'A restart cannot be started here. Quit the app and open it again.',
  },
}

/** 横幅样式：复用上游 .dshMarketBanner 的盒子，只多一列按钮。 */
export function addMarketRestartStyles(styles) {
  return insertBefore(styles.replaceAll('\r\n', '\n'), '.dshMarketBanner {', `.dshMarketRestartBanner {
  align-items: flex-start;
  margin-bottom: 0;
  background: var(--dsw-alias-bg-layer-2);
}

.dshMarketRestartBannerText {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dshMarketRestartBannerText strong {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

.dshMarketRestartBannerPlugins {
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

`, LABEL)
}

/**
 * 设置页的重启横幅产品回归，追加在上游用例之后；同时给上游的 api.js 替身补上
 * 新导出——那是个显式列举的工厂，少一个名字整页用例都加载不了。
 */
export function addMarketRestartUiTests(tests) {
  tests = replaceOnce(tests.replaceAll('\r\n', '\n'), `  readMoreMarketCatalog,
  setMarketInstallationEnabled,
} from '../src/client/api.js'`, `  readMoreMarketCatalog,
  requestMarketRestart,
  setMarketInstallationEnabled,
} from '../src/client/api.js'`, LABEL)
  tests = replaceOnce(tests, `  readMarketState: vi.fn(),
  setMarketInstallationEnabled: vi.fn(),`, `  readMarketState: vi.fn(),
  requestMarketRestart: vi.fn(),
  setMarketInstallationEnabled: vi.fn(),`, LABEL)
  tests = replaceOnce(tests, `const desktopActions = { openTerminal: true } as const`,
    `const desktopActions = { openTerminal: true, restart: true } as const`, LABEL)
  return tests + `
describe('product market restart prompt', () => {
  const managed = {
    kind: 'profile' as const,
    packageName: '@tokensapi/dsh-connect',
    version: '2.9.6',
    enabled: true,
    installed: true,
    toggleable: true,
    removable: true,
  }
  const preview = {
    action: 'update' as const,
    previewId: 'restart-token',
    profileName: 'default',
    packageName: managed.packageName,
    displayName: managed.packageName,
    version: '2.9.7',
    updateFrom: managed.version,
    expiresAt: '2099-01-01',
  }

  const restartBanner = async (): Promise<HTMLElement> => {
    const title = await screen.findByText(en.restartBannerTitle)
    const banner = title.closest('.dshMarketRestartBanner')
    expect(banner).not.toBeNull()
    return banner as HTMLElement
  }

  async function update(
    application: 'applied' | 'restart-required',
    restartReason?: import('../src/api-types.js').MarketRestartReason,
  ) {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [
      { ...managed, updateVersion: '2.9.7', updateStatus: 'available' as const },
    ] })
    vi.mocked(previewMarketOperation).mockResolvedValue(preview)
    vi.mocked(executeMarketOperation).mockResolvedValue({
      action: 'update', packageName: managed.packageName, version: '2.9.7', application,
      ...(restartReason === undefined ? {} : { restartReason }),
    })
    render(<MarketSettingsTab {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.installed }))
    fireEvent.click(await screen.findByRole('button', { name: \`\${en.updatePlugin}: \${managed.packageName}\` }))
    fireEvent.click(await screen.findByRole('button', { name: en.confirmUpdate }))
    expect(await screen.findByText(new RegExp(en.updateComplete, 'u'))).toBeTruthy()
  }

  it('names the plugin and offers a restart when the Host could not hot-swap its dependencies', async () => {
    // 这正是连接中心 2.9.6 → 2.9.7 的真机形态：插件自己的模块换了，undici 没换。
    await update('restart-required', 'module-comparison')
    const banner = await restartBanner()
    expect(within(banner).getByText(en.restartBannerShared)).toBeTruthy()
    expect(within(banner).getByText(new RegExp(managed.packageName, 'u'))).toBeTruthy()
    fireEvent.click(within(banner).getByRole('button', { name: en.restartNow }))
    await waitFor(() => expect(requestMarketRestart).toHaveBeenCalledWith(expect.any(AbortSignal)))
  })

  it('says only that the change is saved when the Host gave no reason', async () => {
    await update('restart-required')
    const banner = await restartBanner()
    expect(within(banner).getByText(en.restartBannerGeneric)).toBeTruthy()
    expect(within(banner).queryByText(en.restartBannerShared)).toBeNull()
  })

  it('stays silent when the official manager applied the change live', async () => {
    await update('applied')
    expect(screen.queryByText(en.restartBannerTitle)).toBeNull()
    expect(requestMarketRestart).not.toHaveBeenCalled()
  })

  it('shows what an earlier change left pending as soon as the surface mounts again', async () => {
    // 换标签页重新挂载：待重启由宿主的状态端点报，渲染层不自己记。
    vi.mocked(readMarketState).mockResolvedValue({
      ...emptyState,
      pendingRestarts: [{ packageName: managed.packageName, reason: 'module-comparison' }],
    })
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
    render(<MarketSettingsTab {...props} />)
    const banner = await restartBanner()
    expect(within(banner).getByText(en.restartBannerShared)).toBeTruthy()
    expect(within(banner).getByText(new RegExp(managed.packageName, 'u'))).toBeTruthy()
  })

  it('hides the button where the Host cannot restart, and still says a restart is needed', async () => {
    vi.mocked(readMarketState).mockResolvedValue({
      sources: [],
      builtIns: [],
      desktopActions: { openTerminal: false },
      pendingRestarts: [{ packageName: managed.packageName }],
    })
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [] })
    render(<MarketSettingsTab {...props} />)
    const banner = await restartBanner()
    expect(within(banner).getByText(en.restartBannerGeneric)).toBeTruthy()
    expect(within(banner).queryByRole('button', { name: en.restartNow })).toBeNull()
  })
})
`
}

/**
 * 把宿主已经报出的「这次变更要重启才生效」接到市场界面上。
 * @param input - staging 副本中市场各文件的内容。
 * @returns 改写后的各文件内容。
 * @throws 上游锚点变化时抛 AnchorError，中断装配待人工复查。
 */
export function addMarketRestartPrompt(input) {
  const { service, routes, types, index, api, settingsTab, locales, styles } = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.replaceAll('\r\n', '\n')]),
  )
  let localised = locales
  for (const [language, entries] of Object.entries(MESSAGES)) {
    const anchor = language === 'zh' ? "  tab: '插件市场'," : "  tab: 'Plugin Market',"
    localised = replaceOnce(localised, anchor,
      anchor + '\n' + Object.entries(entries).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join('\n'), LABEL)
  }
  return {
    types: reportRestartReason(types),
    service: keepRestartReason(service),
    routes: addRestartRoute(routes),
    index: acceptRestartCapability(index),
    api: addMarketRestartCall(api),
    settingsTab: addRestartBanner(settingsTab),
    locales: localised,
    styles: addMarketRestartStyles(styles),
  }
}
