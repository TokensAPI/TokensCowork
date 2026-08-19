import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildUninstallArguments, isUninstallComplete } from './uninstall-windows.mjs'

/* --------------------- _?= 的两条硬约束 --------------------- */

test('puts _?= last so NSIS parses it as the in-place directory', () => {
  const args = buildUninstallArguments('C:\\Apps\\TokensHarness', { keepAppData: true })
  assert.equal(args.at(-1), `_?=${resolve('C:\\Apps\\TokensHarness')}`)
  assert.deepEqual(args.slice(0, -1), ['/S', '/KEEP_APP_DATA'])
})

test('leaves the _?= path unquoted because NSIS takes quotes literally', () => {
  const args = buildUninstallArguments('C:\\Program Files\\TokensHarness')
  const flag = args.at(-1)
  assert.ok(!flag.includes('"'), `path must stay unquoted, got ${flag}`)
  assert.equal(flag, `_?=${resolve('C:\\Program Files\\TokensHarness')}`)
})

test('omits /KEEP_APP_DATA when the caller purges user data', () => {
  const args = buildUninstallArguments('C:\\Apps\\TokensHarness', { keepAppData: false })
  assert.deepEqual(args, ['/S', `_?=${resolve('C:\\Apps\\TokensHarness')}`])
})

test('defaults to purging because keepAppData is opt-in', () => {
  const args = buildUninstallArguments('C:\\Apps\\TokensHarness')
  assert.ok(!args.includes('/KEEP_APP_DATA'))
})

test('resolves a relative directory so NSIS never receives an ambiguous path', () => {
  const args = buildUninstallArguments('.\\stage')
  assert.equal(args.at(-1), `_?=${resolve('.\\stage')}`)
})

test('rejects an empty or non-string install directory', () => {
  for (const value of ['', '   ', undefined, null, 42, {}]) {
    assert.throws(() => buildUninstallArguments(value), /install directory is required/u)
  }
})

/* ------------- 成功判定：只信文件系统，不信退出码 ------------- */

test('treats a removed directory as a completed uninstall', () => {
  assert.equal(isUninstallComplete([], false), true)
})

test('accepts the uninstaller left behind by in-place execution', () => {
  assert.equal(isUninstallComplete(['Uninstall TokensHarness.exe'], true), true)
  assert.equal(isUninstallComplete(['uninstall.exe'], true), true)
})

test('rejects a directory where the application files survived', () => {
  // 这正是缺陷的表现：卸载器返回 0，程序原封不动。
  assert.equal(isUninstallComplete(['TokensHarness.exe', 'resources'], true), false)
  assert.equal(isUninstallComplete(['Uninstall TokensHarness.exe', 'resources'], true), false)
})

test('rejects a directory holding a lookalike that is not the uninstaller', () => {
  assert.equal(isUninstallComplete(['Uninstall TokensHarness.exe.bak'], true), false)
  assert.equal(isUninstallComplete(['NotUninstall.exe'], true), false)
})
