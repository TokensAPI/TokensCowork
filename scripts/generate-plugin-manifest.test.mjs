import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { buildPluginManifest, buildReleaseNotes } from './generate-plugin-manifest.mjs'

const plugin = { id: 'test', displayName: 'Test', description: 'Test plugin', package: 'test',
  version: '1.0.0', repository: 'https://github.com/example/test.git', enabledByDefault: true }
const product = plugins => ({ product: { name: 'TokensCowork', version: '0.5.0' }, plugins })
// Exercise the actual page's standalone classifier without copying its logic or
// starting its network/UI bootstrap. Keep the IIFE's public surface unchanged.
const page = readFileSync(new URL('../download/app.js', import.meta.url), 'utf8')
const classifier = page.match(/  function isPureRelease\(release\) \{[\s\S]*?\n  \}/u)
assert.ok(classifier)
const isPureRelease = new Function(`${classifier[0]}; return isPureRelease;`)()

test('manifest and release distribution use only enabled plugins', () => {
  const manifest = product([plugin, { ...plugin, id: 'disabled', enabledByDefault: false }])
  assert.equal(buildPluginManifest(manifest).plugins.length, 1)
  assert.equal(buildPluginManifest(manifest).plugins[0].homepage, 'https://github.com/example/test')
  const notes = '# TokensCowork v0.5.0\n\nChanges.'
  const body = buildReleaseNotes(manifest, notes)
  assert.ok(body.startsWith(notes))
  assert.equal(buildReleaseNotes(manifest, body), body)
  assert.equal(isPureRelease({ tag_name: 'v0.5.0', body }), false)
  const clean = buildReleaseNotes(product([]), body)
  assert.equal((clean.match(/tokenscowork:distribution=/g) ?? []).length, 1)
  assert.equal(isPureRelease({ tag_name: 'v0.5.1', body: clean }), true)
  assert.equal(isPureRelease({ tag_name: 'v0.5.0', body: buildReleaseNotes(product([{ ...plugin, enabledByDefault: false }]), notes) }), true)
})

test('legacy releases retain classification; channel flags do not override distribution', () => {
  assert.equal(isPureRelease(null), false)
  assert.equal(isPureRelease({ tag_name: 'v0.3.0' }), true)
  assert.equal(isPureRelease({ tag_name: 'v0.3.13' }), false)
  assert.equal(isPureRelease({ tag_name: 'v0.5.0', prerelease: true,
    body: buildReleaseNotes(product([plugin]), 'Changes.') }), false)
})

test('publication generates notes from the same pinned product as the plugin manifest', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.ok(workflow.includes('node scripts/generate-plugin-manifest.mjs --release-notes'))
  assert.ok(workflow.includes('release_notes="release-assets/release-notes.md"'))
  assert.ok(workflow.includes('--notes-file "${release_notes}"'))
  assert.throws(() => buildPluginManifest(product([{ ...plugin, description: '' }])), /缺少/)
})
