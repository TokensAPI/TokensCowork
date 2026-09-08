import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { describe, expect, it, vi } from 'vitest'
import {
  ensureWindowsAclHostConsole,
  type WindowsConsoleBindings,
} from '../src/windows-acl-host-console.ts'
import {
  STATUS_DLL_INIT_FAILED,
  WindowsAclInfrastructureFuse,
  isWindowsAclInfrastructureFailure,
  windowsAclFuseContext,
} from '../src/windows-acl-infrastructure-fuse.ts'

function bindings(overrides: Partial<WindowsConsoleBindings> = {}): WindowsConsoleBindings {
  return {
    getConsoleCP: vi.fn(() => 0),
    attachConsole: vi.fn(() => 0),
    allocConsole: vi.fn(() => 1),
    getConsoleWindow: vi.fn(() => 123n),
    showWindow: vi.fn(() => 1),
    getStdHandle: vi.fn(kind => `handle:${kind}`),
    setStdHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => 6),
    ...overrides,
  }
}

describe('product Windows ACL host console', () => {
  it('does nothing off Windows', () => {
    const api = bindings()
    expect(ensureWindowsAclHostConsole('linux', api)).toBe('non-windows')
    expect(api.getConsoleCP).not.toHaveBeenCalled()
  })

  it('keeps an existing console or ConPTY association unchanged', () => {
    const api = bindings({ getConsoleCP: vi.fn(() => 65001) })
    expect(ensureWindowsAclHostConsole('win32', api)).toBe('existing')
    expect(api.attachConsole).not.toHaveBeenCalled()
    expect(api.allocConsole).not.toHaveBeenCalled()
  })

  it('attaches a parent console, restores Desktop pipes, and never hides the parent window', () => {
    const api = bindings({ attachConsole: vi.fn(() => 1) })
    expect(ensureWindowsAclHostConsole('win32', api)).toBe('attached')
    expect(api.setStdHandle).toHaveBeenCalledTimes(3)
    expect(api.allocConsole).not.toHaveBeenCalled()
    expect(api.showWindow).not.toHaveBeenCalled()
  })

  it('attaches to a windowless helper console so no window ever exists', () => {
    // 桌面启动的常规路径:挂到 CREATE_NO_WINDOW 辅助进程的控制台上,
    // 全程不 AllocConsole、不 ShowWindow——不存在可闪现的窗口。
    const attach = vi.fn()
      .mockReturnValueOnce(0) // parent attach fails (Explorer launch)
      .mockReturnValue(1) // owner attach succeeds
    const kill = vi.fn()
    const api = bindings({ attachConsole: attach })
    const result = ensureWindowsAclHostConsole('win32', api, () => ({ pid: 4242, kill }))
    expect(result).toBe('owner')
    expect(attach).toHaveBeenCalledWith(4242)
    expect(api.allocConsole).not.toHaveBeenCalled()
    expect(api.showWindow).not.toHaveBeenCalled()
    expect(api.setStdHandle).toHaveBeenCalledTimes(3)
  })

  it('falls back to alloc-and-hide only when the helper cannot start', () => {
    const api = bindings()
    const result = ensureWindowsAclHostConsole('win32', api, () => undefined)
    expect(result).toBe('allocated')
    expect(api.allocConsole).toHaveBeenCalledOnce()
    expect(api.showWindow).toHaveBeenCalledWith(123n, 0)
    expect(api.setStdHandle).toHaveBeenCalledTimes(3)
  })

  it('fails closed when neither attach nor allocation can establish a console', () => {
    const errors = [6, 5]
    const api = bindings({
      allocConsole: vi.fn(() => 0),
      getLastError: vi.fn(() => errors.shift() ?? 0),
    })
    expect(() => ensureWindowsAclHostConsole('win32', api, () => undefined))
      .toThrow('AttachConsole Win32 6; AllocConsole Win32 5')
  })
})

describe('product Windows ACL infrastructure fuse', () => {
  const policy = (
    mode: SandboxExecutionPolicy['mode'],
    sessionId?: string,
  ): SandboxExecutionPolicy => ({
    mode,
    workspaceRoot: 'C:\\Workspace',
    ...(sessionId === undefined ? {} : {
      sessionId: sessionId as NonNullable<SandboxExecutionPolicy['sessionId']>,
    }),
  })

  it('recognizes only the empty-output, non-cancelled DLL-init failure', () => {
    const failure = {
      exitCode: STATUS_DLL_INIT_FAILED,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: { text: '' },
      stderr: { text: '' },
    }
    expect(isWindowsAclInfrastructureFailure(failure)).toBe(true)
    expect(isWindowsAclInfrastructureFailure({ ...failure, stderr: { text: 'command output' } })).toBe(false)
    expect(isWindowsAclInfrastructureFailure({ ...failure, exitCode: 1 })).toBe(false)
  })

  it('blocks only the failed session and confined mode', () => {
    const fuse = new WindowsAclInfrastructureFuse()
    const failed = windowsAclFuseContext(policy('workspace-write', 'session-a'))!
    const otherMode = windowsAclFuseContext(policy('read-only', 'session-a'))!
    const otherSession = windowsAclFuseContext(policy('workspace-write', 'session-b'))!

    expect(fuse.isBlocked(failed)).toBe(false)
    fuse.trip(failed)
    expect(fuse.isBlocked(failed)).toBe(true)
    expect(fuse.isBlocked(otherMode)).toBe(false)
    expect(fuse.isBlocked(otherSession)).toBe(false)
    expect(windowsAclFuseContext(policy('danger-full-access', 'session-a'))).toBeUndefined()
  })
})
