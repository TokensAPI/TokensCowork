import { createRequire } from 'node:module'

const ATTACH_PARENT_PROCESS = 0xffff_ffff
const STD_INPUT_HANDLE = 0xffff_fff6
const STD_OUTPUT_HANDLE = 0xffff_fff5
const STD_ERROR_HANDLE = 0xffff_fff4
const SW_HIDE = 0

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

export type WindowsConsolePreparation = 'non-windows' | 'existing' | 'attached' | 'allocated'

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

function isNullHandle(handle: NativeHandle | null): boolean {
  return handle === null || handle === 0 || handle === 0n
}

/**
 * Give the Electron Node-mode ACL runner a host console for restricted console
 * children to inherit. AllocConsole is applied to the unrestricted runner,
 * never to the WRITE_RESTRICTED child that fails console initialization.
 */
export function ensureWindowsAclHostConsole(
  platform: NodeJS.Platform = process.platform,
  bindings?: WindowsConsoleBindings,
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

  // Explorer-launched Electron has no attachable parent console. Allocate one
  // on the unrestricted runner, hide only that newly owned window, then keep
  // the console association alive until the runner exits.
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
