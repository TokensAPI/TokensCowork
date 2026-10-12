/* ============================================================
 * 产品覆盖：Windows ACL 启动链
 * ============================================================
 * 为 Electron Node 模式的 ACL runner 建立宿主控制台（修复
 * 0xC0000142），并给空输出的基础设施失败装会话级熔断。
 * 每个导出函数自带锚点守护：上游代码变动导致锚点失配时装配立即
 * 失败，等待人工复查，绝不静默漏掉覆盖。
 * ============================================================ */

/**
 * Make the Electron Node-mode trampoline establish a real host console before
 * the upstream WRITE_RESTRICTED runner creates console-subsystem children.
 * @param source - staging copy of windows-acl-runner.ts.
 * @returns runner source with the product console bootstrap installed.
 * @throws when the pinned upstream anchors change.
 */
export function addWindowsAclHostConsole(source) {
  const importAnchor = "import { fileURLToPath, pathToFileURL } from 'node:url'"
  const validationAnchor = `  if (requestedRunner !== expectedRunner) {
    throw new Error('desktop trampoline received an unexpected ACL runner')
  }
`
  // 上游自带 AllocConsole；产品已附着无窗口控制台，不能再次分配。
  const upstreamConsole = "import { ensureWindowsConsoleHost } from './windows-console-host.ts'\n"
  const upstreamConsoleCall = '  ensureWindowsConsoleHost()\n'
  if (source.split(importAnchor).length !== 2
    || source.split(validationAnchor).length !== 2
    || source.split(upstreamConsole).length !== 2
    || source.split(upstreamConsoleCall).length !== 2) {
    throw new Error('prepare-desktop: 未找到 Windows ACL trampoline 锚点，请复查宿主控制台覆盖')
  }
  return source
    .replace(upstreamConsole, '')
    .replace(upstreamConsoleCall, '')
    .replace(
      importAnchor,
      `${importAnchor}\nimport { ensureWindowsAclHostConsole } from './windows-acl-host-console.ts'`,
    )
    .replace(
      validationAnchor,
      `${validationAnchor}  ensureWindowsAclHostConsole()\n`,
    )
}

/**
 * Classify the empty-output 0xC0000142 startup shape as sandbox infrastructure
 * failure and trip a per-session fuse so repeated calls do not spawn again.
 * @param source - staging copy of windows-pwsh-sandbox.ts.
 * @returns executor source with the product infrastructure fuse installed.
 * @throws when the pinned upstream anchors change.
 */
export function addWindowsAclInfrastructureFuse(source) {
  // DSH 0.2 前台/后台共用 executeArgv；保留上游准备时限和 onStarted 回调。
  const importAnchor = "import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'"
  const classAnchor = 'export class DesktopWindowsPwshSandbox extends SandboxPwshExecutor {\n'
  const methodStart = source.indexOf('  protected override executeArgv(')
  const methodEnd = source.indexOf('\n}\n', methodStart)
  if (methodStart < 0 || methodEnd < 0 || source.split(importAnchor).length !== 2
    || source.split(classAnchor).length !== 2 || source.includes('aclInfrastructureFuse')) {
    throw new Error('prepare-desktop: 新版 ACL execution 接口变化')
  }
  const method = `  protected override async executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (process: ShellExecution) => void,
  ): Promise<ShellExecution> {
    let context: ReturnType<typeof windowsAclFuseContext>
    const pending: ShellExecSpec = { ...spec }
    const adapt = (argv: readonly string[]) => {
      const adapted = this.adapt(spec, argv)
      context = adapted.argv === argv ? undefined : windowsAclFuseContext(spec.sandboxPolicy)
      if (context !== undefined && this.aclInfrastructureFuse.isBlocked(context)) {
        throw new SandboxUnavailableError(context.mode, 'Windows ACL infrastructure failed; do not retry this confined shell mode.')
      }
      pending.env = adapted.spec.env
      return adapted.argv
    }
    const installFuse = (execution: ShellExecution): void => {
      if (context === undefined) return
      const fuseContext = context
      const result = execution.result.bind(execution)
      execution.result = async () => {
        const settled = await result()
        if (isWindowsAclInfrastructureFailure(settled)) {
          this.aclInfrastructureFuse.trip(fuseContext)
          throw new SandboxUnavailableError(fuseContext.mode, 'Windows ACL infrastructure failed; do not retry this confined shell mode.')
        }
        return settled
      }
      void execution.done.then(() => {
        if (!isWindowsAclProcessInfrastructureFailure(execution.exitCode, execution.signal)) return
        this.aclInfrastructureFuse.trip(fuseContext)
        execution.sandbox = { ...(execution.sandbox ?? { mode: fuseContext.mode, denied: false }), runnerFailed: true }
      })
    }
    return super.executeArgv(pending,
      typeof argvOrPrepare === 'function'
        ? async signal => adapt(await argvOrPrepare(signal))
        : adapt(argvOrPrepare), execution => {
          installFuse(execution)
          onStarted?.(execution)
        })
  }`
  return (source.slice(0, methodStart) + method + source.slice(methodEnd))
    .replace(importAnchor, `${importAnchor}\nimport { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'\nimport { WindowsAclInfrastructureFuse, windowsAclFuseContext, isWindowsAclInfrastructureFailure, isWindowsAclProcessInfrastructureFailure } from './windows-acl-infrastructure-fuse.ts'`)
    .replace(classAnchor, `${classAnchor}  private readonly aclInfrastructureFuse = new WindowsAclInfrastructureFuse()\n`)
}
