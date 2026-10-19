import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { addWindowsAclInfrastructureFuse, addWindowsAclHostConsole, alignWindowsAclConsoleSpec } from './windows-acl-overlay.mjs'

const upstream = readFileSync(new URL('../../../desktop/dsh-plugin-desktop/src/windows-pwsh-sandbox.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const patched = addWindowsAclInfrastructureFuse(upstream)
const fuseCode = stripTypeScriptTypes(readFileSync(new URL('./assets/windows/acl/infrastructure-fuse.ts', import.meta.url), 'utf8'))
  .replace(/^import[^\n]*\n/gm, '').replace(/\bexport /g, '')
const fuse = new Function(fuseCode + '\nreturn { WindowsAclInfrastructureFuse, windowsAclFuseContext, isWindowsAclInfrastructureFailure, isWindowsAclProcessInfrastructureFailure }')()
const classCode = stripTypeScriptTypes(patched.slice(patched.indexOf('export class DesktopWindowsPwshSandbox'), patched.indexOf('export default'))).replace('export ', '')

test('product console replaces upstream allocation instead of initializing twice', () => {
  const source = readFileSync(new URL('../../../desktop/dsh-plugin-desktop/src/windows-acl-runner.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const result = addWindowsAclHostConsole(source)
  assert.equal((result.match(/ensureWindowsAclHostConsole\(\)/g) ?? []).length, 1)
  assert.ok(!result.includes('ensureWindowsConsoleHost'))
  assert.ok(result.includes('await import(pathToFileURL(expectedRunner).href)'))
})

test('upstream trampoline cases mock the product console module, leaving its own unit tests alone', () => {
  const spec = readFileSync(new URL('../../../desktop/dsh-plugin-desktop/tests/windows-pwsh-sandbox.spec.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const result = alignWindowsAclConsoleSpec(spec)
  const trampoline = result.slice(result.indexOf("describe('Windows ACL runner trampoline'"))
  const block = trampoline.slice(0, trampoline.indexOf('\ndescribe('))
  assert.ok(!block.includes("'../src/windows-console-host.ts'"))
  assert.equal((block.match(/'\.\.\/src\/windows-acl-host-console\.ts'/g) ?? []).length, 4)
  assert.equal((block.match(/ensureWindowsAclHostConsole/g) ?? []).length, 2)
  // trampoline 之后的用例直接测试上游实现，产品保留该文件，不能被改写。
  assert.ok(result.slice(result.indexOf('\ndescribe(', result.indexOf("describe('Windows ACL runner trampoline'"))).includes('ensureWindowsConsoleHost('))
  assert.throws(() => alignWindowsAclConsoleSpec(spec.replace("vi.doMock('../src/windows-console-host.ts', () => ({ ensureWindowsConsoleHost }))", '')), /trampoline/)
})

test('unified ACL execution forwards preparation, environment and callback, then blocks only failed session/mode', async () => {
  const calls = []
  const signal = new AbortController().signal
  class Base {
    async executeArgv(spec, prepare, started) {
      const argv = typeof prepare === 'function' ? await prepare(signal) : prepare
      calls.push({ spec, argv })
      const result = { exitCode: 0xc0000142, signal: null, timedOut: false, aborted: false, stdout: { text: '' }, stderr: { text: '' } }
      const ex = { ...result, sandbox: undefined, done: Promise.resolve(), result: async () => result }
      started?.(ex)
      return ex
    }
  }
  class Unavailable extends Error { constructor(mode, message) { super(message); this.mode = mode } }
  const names = ['SandboxPwshExecutor', 'desktopWindowsPwshConfig', 'adaptWindowsAclExecution', 'UPSTREAM_RUNNER', 'DESKTOP_TRAMPOLINE', 'SandboxUnavailableError', ...Object.keys(fuse)]
  const Executor = new Function(...names, classCode + '\nreturn DesktopWindowsPwshSandbox')(Base, x => x,
    (spec, argv) => argv[0] === 'runner' ? { spec: { ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' } }, argv: ['trampoline'] } : { spec, argv },
    'runner', 'trampoline', Unavailable, ...Object.values(fuse))
  const executor = new Executor({}, {})
  const spec = { env: { KEEP: 'yes' }, sandboxPolicy: { mode: 'workspace-write', sessionId: 'a', workspaceRoot: 'C:\\workspace' } }
  let preparedSignal, callbackResult
  const ex = await executor.executeArgv(spec, async received => { preparedSignal = received; return ['runner'] }, handle => { callbackResult = handle.result() })
  await assert.rejects(callbackResult, { mode: 'workspace-write' })
  await assert.rejects(ex.result(), { mode: 'workspace-write' })
  assert.equal(preparedSignal, signal)
  assert.deepEqual(calls[0].argv, ['trampoline'])
  assert.deepEqual(calls[0].spec.env, { KEEP: 'yes', ELECTRON_RUN_AS_NODE: '1' })
  assert.deepEqual(spec.env, { KEEP: 'yes' })
  assert.equal(ex.sandbox.runnerFailed, true)
  await assert.rejects(executor.executeArgv(spec, ['runner']), { mode: 'workspace-write' })
  assert.equal(calls.length, 1)
  await executor.executeArgv({ ...spec, sandboxPolicy: { ...spec.sandboxPolicy, sessionId: 'b' } }, ['runner'])
  await executor.executeArgv(spec, ['ordinary'])
  assert.equal(calls.length, 3)
})

test('ACL overlay rejects repeated application and missing class anchors', () => {
  assert.throws(() => addWindowsAclInfrastructureFuse(patched))
  assert.throws(() => addWindowsAclInfrastructureFuse(upstream.replace('export class DesktopWindowsPwshSandbox', 'export class Changed')))
})
