import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { skipDesktopSetupWizard } from './desktop-runtime-overlay.mjs'

const source = readFileSync(new URL('../../../desktop/dsh-plugin-desktop/src/main.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')

test('page onboarding records product skip only when required and leaves safe mode untouched', async () => {
  const patched = skipDesktopSetupWizard(source)
  const start = patched.indexOf('    if (safeModePaths === undefined) {\n      if (desktopSetupWizardRequired')
  const end = patched.indexOf('    if (setupPending)', start)
  assert.ok(start > 0 && end > start)
  const run = new Function('safeModePaths', 'desktopSetupWizardRequired', 'completeOrSkipDesktopSetupWizard', 'dismissDesktopSetupAccount',
    'setupWizardState', 'setupWizardVersions', 'marketUserDataDir', 'prepared', 'desktopSetupWizardPending', 'hasDesktopProfileUsageHistory',
    `return (async () => { ${patched.slice(start, end)}; return setupPending })()`)
  for (const [safe, required, expectedWrites] of [[undefined, true, 1], [undefined, false, 0], [{}, true, 0]]) {
    const writes = [], dismissals = []
    const versions = { current: 'fixture' }
    const pending = await run(safe, () => required, async (...args) => writes.push(args), (...args) => dismissals.push(args), {}, versions, '/user', { profile: { dir: '/profile' } }, () => { throw new Error('unexpected old pending read') }, () => false)
    assert.equal(pending, false)
    assert.equal(writes.length, expectedWrites)
    if (expectedWrites) assert.deepEqual(writes[0], ['/user', '/profile', 'skipped', versions])
    assert.equal(dismissals.length, safe === undefined ? 1 : 0)
  }
})
