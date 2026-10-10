import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePromotion, validatePromotionSource } from './promote-release.mjs'
import { fullNotes } from './full-release-notes-fixture.mjs'
const candidate = {
  tag_name: 'v0.5.14', prerelease: true, draft: false,
  assets: ['windows-amd64-installer.exe', 'macos-arm64-installer.dmg', 'macos-amd64-installer.dmg', 'SHA256SUMS.txt', 'plugins.json'].map(suffix => ({ name: `TokensCowork-0.5.14-${suffix}`, size: 100 })),
}
const stable = { tag_name: 'v0.5.13', prerelease: false, draft: false }
test('promotion cannot apply a passing regression result to a moved tag', () => {
  const commit = 'a'.repeat(40)
  validatePromotionSource(commit, commit)
  assert.throws(() => validatePromotionSource(commit, 'b'.repeat(40)), /changed after regression/)
  assert.throws(() => validatePromotionSource(undefined, commit), /changed after regression/)
})
test('promotion preserves completed candidates and requires cumulative stable notes', () => {
  assert.deepEqual(validatePromotion(candidate, [stable, candidate], fullNotes()), { version: '0.5.14', previousStable: 'v0.5.13' })
  assert.throws(() => validatePromotion(candidate, [stable], fullNotes('0.5.14', '0.5.12')), /since v0.5.13/)
  const mixed = fullNotes().replace('## Full Changelog\n\n[View all commits from v0.5.13 to v0.5.14](https://github.com/TokensAPI/TokensCowork/compare/v0.5.13...v0.5.14)', '## Full Changelog\n\n[Changes](https://github.com/TokensAPI/TokensCowork/compare/v0.5.12...v0.5.14)')
  assert.throws(() => validatePromotion(candidate, [stable], mixed), /since v0.5.13/)
  assert.throws(() => validatePromotion(candidate, [{ ...stable, tag_name: 'v0.5.15' }], fullNotes()), /older/)
  assert.throws(() => validatePromotion({ ...candidate, prerelease: false }, [stable], fullNotes()), /pre-release/)
  assert.throws(() => validatePromotion({ ...candidate, draft: true }, [stable], fullNotes()), /pre-release/)
  assert.throws(() => validatePromotion({ ...candidate, assets: candidate.assets.slice(1) }, [stable], fullNotes()), /Missing published asset/)
  assert.throws(() => validatePromotion({ ...candidate, tag_name: 'v0.5.14-rc.1' }, [], fullNotes()), /plain/)
})
