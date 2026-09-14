import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { currentInputs, loadCatalog, reviewEntries, validateCatalog } from './overlay-review.mjs'

const root = resolve(import.meta.dirname, '../..')
const catalog = loadCatalog()
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
test('every module implementation is registered with purpose, callers, tests and removal criteria', () => {
  validateCatalog(catalog)
})
test('an upstream/plugin pin change flags affected overlays without rewriting the baseline', () => {
  const baseline = { ...catalog, entries: catalog.entries.map(entry => ({ ...entry, baseline: currentInputs(product) })) }
  const changed = structuredClone(product)
  changed.desktop.deepseekHarnessCommit = 'new-runtime-pin'
  changed.plugins.find(plugin => plugin.id === 'dsh-tokensapi-ui').artifact.sha256 = 'new-artifact'
  const review = reviewEntries(baseline, changed)
  assert.ok(review.find(entry => entry.id === 'runtime.rpc-scope').changed.includes('dsh'))
  assert.ok(review.find(entry => entry.id === 'market.dialog-position').changed.includes('ui'))
  assert.deepEqual(review.find(entry => entry.id === 'platform.packaging').changed, [])
  assert.ok(baseline.entries.every(entry => JSON.stringify(entry.baseline) === JSON.stringify(currentInputs(product))))
})
test('inactive and already-upstream fixes cannot be mistaken for injected patches', () => {
  assert.equal(catalog.entries.find(entry => entry.id === 'runtime.legacy-profile').state, 'inactive')
  assert.equal(catalog.entries.find(entry => entry.id === 'runtime.presets-asar').state, 'upstream')
})
for (const mode of ['check', 'win', 'mac', 'mac-unsigned']) {
  test(`${mode} plan is executable cross-platform and preserves common preflight order`, () => {
    const result = spawnSync(process.execPath, ['build/build.mjs', mode, '--plan'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PRODUCT_STAGE_NAME: 'desktop-plan-does-not-exist' },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = result.stdout
    for (const [, file] of output.matchAll(/\bnode (build\/\S+\.mjs)\b/g)) {
      assert.ok(existsSync(resolve(root, file)), `Plan references missing command: ${file}`)
    }
    const sequence = ['repo-layout-verify.mjs', 'plugin-artifacts-fetch.mjs', 'staging-prepare.mjs',
      'install --immutable', 'staging-runtime-patch.mjs', 'staging-rpc-smoke.mjs',
      'staging-plugins-compile.mjs', 'staging-plugins-prune.mjs', 'verify:licenses']
    let previous = -1
    for (const step of sequence) {
      const offset = output.indexOf(step)
      assert.ok(offset > previous, `Missing/out-of-order: ${step}`)
      previous = offset
    }
    if (mode === 'check') assert.ok(!output.includes('electron-builder'))
    if (mode === 'win') {
      assert.ok(output.indexOf('check:win-package') < output.indexOf('staging-product-configure'))
      assert.ok(output.indexOf('typecheck') < output.indexOf('electron-builder'))
      assert.ok(output.indexOf('electron-builder') < output.indexOf('packaged-app-verify'))
    }
    if (mode === 'mac') assert.ok(output.includes('dist:mac'))
    if (mode === 'mac-unsigned') assert.ok(output.includes('--config.mac.identity=null'))
  })
}

test('build root stays limited to entrypoint, documentation, pipeline and modules', () => {
  assert.deepEqual(readdirSync(resolve(root, 'build')).sort(), ['README.md', 'build.mjs', 'modules', 'pipeline'])
})
