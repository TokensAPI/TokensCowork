import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const ATTACH_PARENT_PROCESS = 0xffff_ffff
const STD_INPUT_HANDLE = 0xffff_fff6
const STD_OUTPUT_HANDLE = 0xffff_fff5
const STD_ERROR_HANDLE = 0xffff_fff4
const SW_HIDE = 0
// PowerShell 5.1 冷启动在 Defender 实扫下可达 1-2s；预算取 3s。
const OWNER_ATTACH_ATTEMPTS = 120
const OWNER_ATTACH_INTERVAL_MS = 25

type NativeHandle = unknown

/** Minimal Win32 surface used to establish a console before the ACL child starts. */
export interface WindowsConsoleBindings {
  getConsoleCP(): number
  attachConsole(processId: number): number
  allocConsole(): number
  getConsoleWindow(): NativeHandle | null
  showWindow(window: NativeHandle, command: number): number
  getStdHandle(kind: number): NativeHandle
  setStdHandle(kind: number, handle: NativeHandle): number
  getLastError(): number
}

/** A helper process whose windowless console this runner attaches to. */
export interface WindowsConsoleOwner {
  readonly pid: number
  kill(): void
}

export type WindowsConsolePreparation = 'non-windows' | 'existing' | 'attached' | 'owner' | 'allocated'

let cachedBindings: WindowsConsoleBindings | undefined

function loadWindowsConsoleBindings(): WindowsConsoleBindings {
  cachedBindings ??= (() => {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
    const kernel32 = koffi.load('kernel32.dll')
    const user32 = koffi.load('user32.dll')
    return {
      getConsoleCP: kernel32.func('uint32 __stdcall GetConsoleCP()') as unknown as () => number,
      attachConsole: kernel32.func('int __stdcall AttachConsole(uint32)') as unknown as (processId: number) => number,
      allocConsole: kernel32.func('int __stdcall AllocConsole()') as unknown as () => number,
      getConsoleWindow: kernel32.func('void * __stdcall GetConsoleWindow()') as unknown as () => NativeHandle | null,
      showWindow: user32.func('int __stdcall ShowWindow(void *, int)') as unknown as (
        window: NativeHandle,
        command: number,
      ) => number,
      getStdHandle: kernel32.func('void * __stdcall GetStdHandle(uint32)') as unknown as (
        kind: number,
      ) => NativeHandle,
      setStdHandle: kernel32.func('int __stdcall SetStdHandle(uint32, void *)') as unknown as (
        kind: number,
        handle: NativeHandle,
      ) => number,
      getLastError: kernel32.func('uint32 __stdcall GetLastError()') as unknown as () => number,
    }
  })()
  return cachedBindings
}

/**
 * Start a windowless console owner with CREATE_NO_WINDOW (child_process
 * `windowsHide`): its console exists but never has a window.
 *
 * The owner is PowerShell waiting on THIS runner's pid. Self-terminating by
 * construction: when the runner exits — normally, crashed, or killed —
 * Wait-Process returns and the helper exits with it, so no orphan survives
 * even without Job Objects. PowerShell is also the very binary the sandbox
 * is about to run restricted, so this adds no new AppLocker/AV surface and
 * emits no network traffic.
 */
function spawnHiddenConsoleOwner(): WindowsConsoleOwner | undefined {
  try {
    const powershell = resolve(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    )
    const child = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    ], {
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
    })
    if (child.pid === undefined) return undefined
    // spawn 的启动失败经常经由异步 error 事件报告(AppLocker/WDAC/杀软拦截)。
    // 必须消费,否则未处理异常带崩 runner;attach 重试循环随后自然超时进兜底。
    child.once('error', () => {})
    child.unref()
    const pid = child.pid
    return { pid, kill: () => { try { child.kill() } catch {} } }
  } catch {
    return undefined
  }
}

/** Synchronous sleep for the attach retry loop; the runner has no work to overlap. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isNullHandle(handle: NativeHandle | null): boolean {
  return handle === null || handle === 0 || handle === 0n
}

/**
 * Give the Electron Node-mode ACL runner a host console for restricted console
 * children to inherit. The console is established on the unrestricted runner,
 * never on the WRITE_RESTRICTED child that fails console initialization.
 *
 * Window-free by construction: a bare AllocConsole creates a visible window
 * and hides it afterwards, which flashes on screen once per command. Instead
 * the runner attaches to a helper process whose console was created with
 * CREATE_NO_WINDOW, so no window ever exists. AllocConsole+hide remains only
 * as the last-resort fallback when the helper cannot be started.
 */
export function ensureWindowsAclHostConsole(
  platform: NodeJS.Platform = process.platform,
  bindings?: WindowsConsoleBindings,
  spawnOwner: () => WindowsConsoleOwner | undefined = spawnHiddenConsoleOwner,
): WindowsConsolePreparation {
  if (platform !== 'win32') return 'non-windows'
  const api = bindings ?? loadWindowsConsoleBindings()

  // GetConsoleWindow can be null for ConPTY. GetConsoleCP is the reliable
  // question here: does this process already have a console association?
  if (api.getConsoleCP() !== 0) return 'existing'

  const handles = [
    [STD_INPUT_HANDLE, api.getStdHandle(STD_INPUT_HANDLE)],
    [STD_OUTPUT_HANDLE, api.getStdHandle(STD_OUTPUT_HANDLE)],
    [STD_ERROR_HANDLE, api.getStdHandle(STD_ERROR_HANDLE)],
  ] as const

  const restoreStdHandles = (): void => {
    let firstError: number | undefined
    for (const [kind, handle] of handles) {
      if (api.setStdHandle(kind, handle) === 0 && firstError === undefined) {
        firstError = api.getLastError()
      }
    }
    if (firstError !== undefined) {
      throw new Error(`SetStdHandle failed while restoring Desktop pipes (Win32 ${firstError})`)
    }
  }

  // A terminal-launched product should reuse its parent console and must not
  // hide a window owned by that parent.
  if (api.attachConsole(ATTACH_PARENT_PROCESS) !== 0) {
    restoreStdHandles()
    return 'attached'
  }
  const attachError = api.getLastError()

  // Explorer-launched Electron has no attachable parent console. Attach to a
  // helper whose console was created windowless; nothing ever appears on
  // screen. The helper stays alive as the console owner until the runner ends.
  const owner = spawnOwner()
  if (owner !== undefined) {
    for (let attempt = 0; attempt < OWNER_ATTACH_ATTEMPTS; attempt++) {
      if (api.attachConsole(owner.pid) !== 0) {
        process.once('exit', () => owner.kill())
        restoreStdHandles()
        return 'owner'
      }
      sleepSync(OWNER_ATTACH_INTERVAL_MS)
    }
    owner.kill()
  }

  // Last resort: own console, hidden immediately after creation. This can
  // flash a window for one frame; it only runs when the helper spawn failed.
  if (api.allocConsole() === 0) {
    const allocError = api.getLastError()
    throw new Error(
      `could not establish the Windows ACL host console `
      + `(AttachConsole Win32 ${attachError}; AllocConsole Win32 ${allocError})`,
    )
  }

  try {
    const window = api.getConsoleWindow()
    if (!isNullHandle(window)) api.showWindow(window, SW_HIDE)
  } finally {
    restoreStdHandles()
  }
  return 'allocated'
}
