import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { currentPins, loadReviews, pinChanges, validateRegistry } from './overlay-doctor.mjs'
import { loadOverlays } from './overlay-engine.mjs'
import { withoutPnpLoader } from './node-environment.mjs'

const root = resolve(import.meta.dirname, '../..')
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
test('every module file is reachable from its registry and evidence references real overlays', async () => {
  await validateRegistry()
})
test('a pin change flags only the overlays declaring that upstream input', async () => {
  const overlays = await loadOverlays()
  const baseline = currentPins(product)
  const changed = structuredClone(product)
  changed.desktop.deepseekHarnessCommit = 'new-runtime-pin'
  changed.plugins.find(plugin => plugin.id === 'tokens-version-updates').commit = 'new-plugin-commit'
  const current = currentPins(changed)
  const flagged = id => pinChanges(overlays.find(overlay => overlay.id === id), baseline, current)
  assert.deepEqual(flagged('runtime.rpc-scope'), ['dsh'])
  assert.deepEqual(flagged('updates.tray-command-id'), ['plugin:tokens-version-updates'])
  assert.deepEqual(flagged('platform.package-identity'), [])
  assert.deepEqual(Object.keys(loadReviews()).sort(), ['branding', 'guard', 'market', 'platform', 'runtime', 'updates'])
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
