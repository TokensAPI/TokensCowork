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
  if (source.split(importAnchor).length !== 2
    || source.split(validationAnchor).length !== 2) {
    throw new Error('prepare-desktop: 未找到 Windows ACL trampoline 锚点，请复查宿主控制台覆盖')
  }
  return source
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
  const importAnchor = "import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'"
  const classAnchor = 'export class DesktopWindowsPwshSandbox extends SandboxPwshExecutor {\n'
  const methodsAnchor = `  protected override async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    const adapted = this.adapt(spec, argv)
    return super.runArgv(adapted.spec, adapted.argv)
  }

  protected override startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    const adapted = this.adapt(spec, argv)
    return super.startArgv(adapted.spec, adapted.argv)
  }`
  if (source.split(importAnchor).length !== 2
    || source.split(classAnchor).length !== 2
    || source.split(methodsAnchor).length !== 2) {
    throw new Error('prepare-desktop: 未找到 Windows ACL executor 锚点，请复查基础设施熔断覆盖')
  }
  const imports = `${importAnchor}
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import {
  WindowsAclInfrastructureFuse,
  isWindowsAclInfrastructureFailure,
  isWindowsAclProcessInfrastructureFailure,
  windowsAclFuseContext,
  type WindowsAclFuseContext,
} from './windows-acl-infrastructure-fuse.ts'`
  const methods = `  private throwAclInfrastructureFailure(context: WindowsAclFuseContext): never {
    throw new SandboxUnavailableError(
      context.mode,
      'the Windows Desktop ACL console child failed during DLL initialization (0xC0000142). '
      + 'The current session fuse is open; do not retry this confined shell mode.',
    )
  }

  private requireAclInfrastructure(context: WindowsAclFuseContext | undefined): void {
    if (context !== undefined && this.aclInfrastructureFuse.isBlocked(context)) {
      this.throwAclInfrastructureFailure(context)
    }
  }

  protected override async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    const adapted = this.adapt(spec, argv)
    const context = adapted.argv === argv ? undefined : windowsAclFuseContext(spec.sandboxPolicy)
    this.requireAclInfrastructure(context)
    const result = await super.runArgv(adapted.spec, adapted.argv)
    if (context !== undefined && isWindowsAclInfrastructureFailure(result)) {
      this.aclInfrastructureFuse.trip(context)
      this.throwAclInfrastructureFailure(context)
    }
    return result
  }

  protected override startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    const adapted = this.adapt(spec, argv)
    const context = adapted.argv === argv ? undefined : windowsAclFuseContext(spec.sandboxPolicy)
    this.requireAclInfrastructure(context)
    const proc = super.startArgv(adapted.spec, adapted.argv)
    if (context !== undefined) {
      void proc.done.then(() => {
        if (!isWindowsAclProcessInfrastructureFailure(proc.exitCode, proc.signal)) return
        this.aclInfrastructureFuse.trip(context)
        proc.sandbox = {
          ...(proc.sandbox ?? { mode: context.mode, denied: false }),
          runnerFailed: true,
        }
      })
    }
    return proc
  }`
  return source
    .replace(importAnchor, imports)
    .replace(classAnchor, `${classAnchor}  private readonly aclInfrastructureFuse = new WindowsAclInfrastructureFuse()\n\n`)
    .replace(methodsAnchor, methods)
}
