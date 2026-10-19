import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { addWindowsInstallerGuard } from './windows-installer-overlay.mjs'

const guard = readFileSync(new URL('./assets/windows/installer/upgrade-guard.nsh', import.meta.url), 'utf8')

test('installer guard is compiled in and upstream user-data deletion is rejected', () => {
  const result = addWindowsInstallerGuard({ build: { nsis: {} } }, guard)
  assert.equal(result.desktopPackage.build.nsis.include, 'build/tokenscowork-upgrade-guard.nsh')
  assert.equal(result.guard, guard)
  assert.throws(() => addWindowsInstallerGuard({ build: { nsis: { deleteAppDataOnUninstall: true } } }, guard), /user data/)
  assert.throws(() => addWindowsInstallerGuard({ build: { nsis: {} } }, 'changed'), /customUnInstallCheck/)
})
