import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

export const STATUS_DLL_INIT_FAILED = 0xc000_0142

export interface WindowsAclFuseContext {
  readonly key: string
  readonly mode: 'read-only' | 'workspace-write'
}

export interface WindowsAclSettledResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdout: { readonly text: string }
  readonly stderr: { readonly text: string }
}

/** Scope the fuse to the calling session and confined mode, with an agentless fallback. */
export function windowsAclFuseContext(
  policy: SandboxExecutionPolicy | undefined,
): WindowsAclFuseContext | undefined {
  if (policy === undefined || policy.mode === 'danger-full-access') return undefined
  const owner = policy.sessionId === undefined
    ? `workspace:${policy.workspaceRoot.toLowerCase()}`
    : `session:${String(policy.sessionId)}`
  return { key: `${owner}\0${policy.mode}`, mode: policy.mode }
}

/** The empty-output NTSTATUS shape produced before the requested command starts. */
export function isWindowsAclInfrastructureFailure(result: WindowsAclSettledResult): boolean {
  return result.exitCode === STATUS_DLL_INIT_FAILED
    && result.signal === null
    && !result.timedOut
    && !result.aborted
    && result.stdout.text.length === 0
    && result.stderr.text.length === 0
}

/** Background processes expose only their final process status at this layer. */
export function isWindowsAclProcessInfrastructureFailure(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  return exitCode === STATUS_DLL_INIT_FAILED && signal === null
}

/** Per-session hard fuse: after infrastructure failure, later calls do not spawn. */
export class WindowsAclInfrastructureFuse {
  private readonly failed = new Set<string>()

  isBlocked(context: WindowsAclFuseContext): boolean {
    return this.failed.has(context.key)
  }

  trip(context: WindowsAclFuseContext): void {
    this.failed.add(context.key)
  }
}
