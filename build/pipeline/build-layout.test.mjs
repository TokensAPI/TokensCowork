import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { currentInputs, loadCatalog, reviewEntries, validateCatalog } from './overlay-review.mjs'
import { withoutPnpLoader } from './node-environment.mjs'

const root = resolve(import.meta.dirname, '../..')
const catalog = loadCatalog()
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
test('a staging subprocess resolves its own dependencies after removing outer PnP injection', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'staging-node-'))
  try {
    mkdirSync(resolve(directory, 'node_modules', 'staging-fixture'), { recursive: true })
    writeFileSync(resolve(directory, 'node_modules', 'staging-fixture', 'index.js'), 'module.exports = 42')
    const loader = resolve(directory, '.pnp.cjs')
    writeFileSync(loader, "throw new Error('outer PnP loader injected')")
    const source = { ...process.env, NODE_OPTIONS: `--require "${loader.replaceAll('\\', '/')}" --max-old-space-size=4096`, COREPACK_ENABLE_PROJECT_SPEC: '1', APPLE_TEAM_ID: 'test-team' }
    const args = ['-e', "console.log(require('staging-fixture'))"]
    const contaminated = spawnSync(process.execPath, args, { cwd: directory, env: source, encoding: 'utf8' })
    assert.notEqual(contaminated.status, 0)
    assert.match(contaminated.stderr, /outer PnP loader injected/)
    const clean = withoutPnpLoader(source)
    assert.equal(clean.NODE_OPTIONS, '--max-old-space-size=4096')
    assert.equal(clean.COREPACK_ENABLE_PROJECT_SPEC, '1')
    assert.equal(clean.APPLE_TEAM_ID, 'test-team')
    assert.ok(source.NODE_OPTIONS.includes('.pnp.cjs'))
    const result = spawnSync(process.execPath, args, { cwd: directory, env: clean, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '42')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
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
    if (mode !== 'check') {
      assert.ok(output.indexOf('workspace dsh-community-market build') < output.indexOf('workspace dsh-plugin-desktop build'))
      assert.doesNotMatch(output, /corepack yarn run build|dsh-plugin-desktop-beta/)
    }
  })
}

test('build root stays limited to entrypoint, documentation, pipeline and modules', () => {
  assert.deepEqual(readdirSync(resolve(root, 'build')).sort(), ['README.md', 'build.mjs', 'modules', 'pipeline'])
})
