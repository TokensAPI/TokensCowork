import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('development synchronizes derived manifests before validation and process shutdown', () => {
  const dev = read('./dev-desktop.ps1')
  const sync = "'node scripts\\generate-market-catalog.mjs'"
  assert.equal(dev.split(sync).length, 2)
  assert.ok(dev.indexOf(sync) < dev.indexOf("'node build\\pipeline\\repo-layout-verify.mjs --working-tree'"))
  assert.ok(dev.indexOf(sync) < dev.indexOf('if (-not (Clear-ConflictingApp))'))
})
test('development validates checkout pins while CI retains strict index and cleanliness checks', () => {
  const dev = read('./dev-desktop.ps1')
  const ci = read('../build/build.mjs')
  const command = "'node build\\pipeline\\repo-layout-verify.mjs --working-tree'"
  assert.equal(dev.split(command).length, 2)
  assert.match(ci, /repo-layout-verify\.mjs'\), '--require-clean'/)
  assert.doesNotMatch(dev, /Invoke-Step[^\n]*--require-clean/)
  assert.ok(dev.indexOf(command) < dev.indexOf('if (-not (Clear-ConflictingApp))'))
  assert.ok(dev.indexOf(command) < dev.indexOf('if ($Prepare)'))
  assert.match(dev, /if \(\$code -ne 0\) \{[\s\S]*?exit 1/)
})

test('working-tree mode permits unstaged pins, not non-submodules; default remains strict', () => {
  const shared = read('../build/pipeline/repo-layout-verify.mjs')
  const body = shared.slice(shared.indexOf('function assertGitlink('), shared.indexOf('\nif (manifest.schemaVersion'))
  const check = (workingTree, mode, object) => {
    const run = new Function('git', 'root', 'workingTree', 'fail', `${body}; assertGitlink('plugin', 'new')`)
    return () => run(() => `${mode} ${object} 0\tplugin`, '.', workingTree, message => { throw new Error(message) })
  }
  assert.doesNotThrow(check(true, '160000', 'old'))
  assert.doesNotThrow(check(false, '160000', 'new'))
  assert.throws(check(false, '160000', 'old'), /gitlink differs/)
  assert.throws(check(true, '100644', 'new'), /gitlink differs/)
  assert.match(shared, /if \(requireClean && workingTree\) fail/)
  assert.match(shared, /git\(pluginPath, 'rev-parse', 'HEAD'\) !== plugin.commit/)
  assert.match(shared, /git\(desktopPath, 'rev-parse', 'HEAD'\) !== manifest.desktop.commit/)
})

test('shared verification checks version and generated market data', () => {
  const shared = read('../build/pipeline/repo-layout-verify.mjs')
  assert.match(shared, /VERSION, product.json, and package.json versions must match/)
  assert.match(shared, /market-catalog-verify\.mjs/)
  assert.match(shared, /checkout differs from product.json/)
})
