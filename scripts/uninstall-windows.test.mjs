import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildUninstallArguments,
  isUninstallComplete,
  normalizeInstallInfo,
  parseUninstallExecutable,
} from './uninstall-windows.mjs'

/* --------------------- _?= 的两条硬约束 --------------------- */

test('puts _?= last so NSIS parses it as the in-place directory', () => {
  const args = buildUninstallArguments('C:\\Apps\\TokensHarness', { deleteAppData: true })
  assert.equal(args.at(-1), `_?=${resolve('C:\\Apps\\TokensHarness')}`)
  assert.deepEqual(args.slice(0, -1), ['/S', '--delete-app-data'])
})

test('leaves the _?= path unquoted because NSIS takes quotes literally', () => {
  const args = buildUninstallArguments('C:\\Program Files\\TokensHarness')
  const flag = args.at(-1)
  assert.ok(!flag.includes('"'), `path must stay unquoted, got ${flag}`)
  assert.equal(flag, `_?=${resolve('C:\\Program Files\\TokensHarness')}`)
})

test('keeps user data by default because deletion is opt-in', () => {
  const args = buildUninstallArguments('C:\\Apps\\TokensHarness')
  assert.deepEqual(args, ['/S', `_?=${resolve('C:\\Apps\\TokensHarness')}`])
})

test('keeps user data when the caller explicitly declines deletion', () => {
  const args = buildUninstallArguments('C:\\Apps\\TokensHarness', { deleteAppData: false })
  assert.ok(!args.includes('--delete-app-data'))
})

test('never emits /KEEP_APP_DATA, which the uninstaller does not parse', () => {
  // uninstaller.nsh 只 GetOptions "--delete-app-data"；/KEEP_APP_DATA 没有解析分支。
  for (const options of [undefined, { deleteAppData: true }, { deleteAppData: false }]) {
    const args = buildUninstallArguments('C:\\Apps\\TokensHarness', options)
    assert.ok(!args.includes('/KEEP_APP_DATA'), `unparsed flag leaked: ${args.join(' ')}`)
  }
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

/* ------------------ 注册表记录与卸载命令解析 ------------------ */

test('extracts the quoted uninstaller path and ignores registry arguments', () => {
  assert.equal(
    parseUninstallExecutable('"C:\\Users\\tester\\AppData\\Local\\Programs\\TokensHarness\\Uninstall TokensHarness.exe" /currentuser'),
    'C:\\Users\\tester\\AppData\\Local\\Programs\\TokensHarness\\Uninstall TokensHarness.exe',
  )
})

test('extracts an unquoted executable without retaining arguments', () => {
  assert.equal(
    parseUninstallExecutable('C:\\Tools\\uninstall.exe /S'),
    'C:\\Tools\\uninstall.exe',
  )
})

test('derives the install directory when electron-builder omits InstallLocation', () => {
  assert.deepEqual(
    normalizeInstallInfo({
      InstallLocation: '',
      UninstallString: '"C:\\Users\\tester\\AppData\\Local\\Programs\\TokensHarness\\Uninstall TokensHarness.exe" /currentuser',
    }),
    {
      installLocation: resolve('C:\\Users\\tester\\AppData\\Local\\Programs\\TokensHarness'),
      uninstallString: 'C:\\Users\\tester\\AppData\\Local\\Programs\\TokensHarness\\Uninstall TokensHarness.exe',
    },
  )
})

test('prefers a populated InstallLocation from the registry', () => {
  assert.equal(
    normalizeInstallInfo({
      InstallLocation: 'C:\\Apps\\TokensHarness',
      UninstallString: '"C:\\Elsewhere\\Uninstall TokensHarness.exe" /currentuser',
    }).installLocation,
    resolve('C:\\Apps\\TokensHarness'),
  )
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

/* ---------------------- NSIS 覆盖升级保护 ---------------------- */

const upgradeGuard = readFileSync(
  resolve(import.meta.dirname, '..', 'build', 'assembly', 'assets', 'windows', 'upgrade-guard.nsh'),
  'utf8',
)

test('makes a failed updated uninstall return a non-zero exit code', () => {
  assert.match(upgradeGuard, /!macro customRemoveFiles/u)
  assert.match(upgradeGuard, /SetErrorLevel 2/u)
  assert.match(upgradeGuard, /Call un\.restoreFiles/u)
})

test('blocks installation when the previous directory survived uninstall', () => {
  assert.match(upgradeGuard, /!macro customUnInstallCheck/u)
  assert.match(upgradeGuard, /InstallLocation/u)
  assert.match(upgradeGuard, /UninstallString/u)
  assert.doesNotMatch(upgradeGuard, /\$installationDir/u)
  assert.match(upgradeGuard, /Quit/u)
})

test('treats an empty leftover directory as a completed uninstall', () => {
  // 空壳目录（根目录被外部句柄占住删不掉）不算卸载失败：安装器和
  // 卸载器都必须用真实文件扫描代替 IfFileExists "目录\*.*" 判定。
  assert.match(upgradeGuard, /Function \$\{UN\}hasSurvivingFiles/u)
  assert.match(upgradeGuard, /Call hasSurvivingFiles/u)
  assert.match(upgradeGuard, /Call un\.hasSurvivingFiles/u)
})

test('restores moved files before a failed updated uninstall quits', () => {
  // 残留真实文件导致失败时必须先恢复应用，否则搬进临时目录的文件
  // 会随卸载器进程退出被清理，用户的安装被整个删掉。
  const removeFiles = upgradeGuard.slice(upgradeGuard.indexOf('!macro customRemoveFiles'))
  const failureBranch = removeFiles.slice(removeFiles.indexOf('Call un.hasSurvivingFiles'))
  assert.match(failureBranch, /Call un\.restoreFiles[\s\S]*?SetErrorLevel 2[\s\S]*?Quit/u)
})
