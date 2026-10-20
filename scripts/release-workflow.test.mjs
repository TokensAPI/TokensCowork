import assert from 'node:assert/strict'
import test from 'node:test'
import { readRelease, validateReleaseTarget } from './release-workflow.mjs'

const target = { operation: 'build', tag: 'v0.5.20', version: '0.5.20', commit: 'a'.repeat(40) }
test('duplicate releases and mismatched tags stop before compiling or submitting', () => {
  assert.equal(validateReleaseTarget(target).commit, target.commit)
  for (const invalid of [{ release: { prerelease: true } }, { tagCommit: 'b'.repeat(40) }, { eventTag: 'v0.5.19' }, { tag: 'v0.5.19' }, { operation: 'other' }]) {
    assert.throws(() => validateReleaseTarget({ ...target, ...invalid }))
  }
})
test('a rehearsal builds packages for an already released version without ever publishing', () => {
  // 演练用来调发布流程本身：允许版本已发出、标签指向别的提交，但 operation 保持 rehearse，发布任务按它跳过。
  const rehearsal = validateReleaseTarget({ ...target, operation: 'rehearse', release: { prerelease: true }, tagCommit: 'b'.repeat(40) })
  assert.equal(rehearsal.operation, 'rehearse')
  assert.equal(rehearsal.tag, target.tag)
  for (const invalid of [{ eventTag: 'v0.5.19' }, { tag: 'v0.5.19' }, { commit: 'short' }]) {
    assert.throws(() => validateReleaseTarget({ ...target, operation: 'rehearse', ...invalid }))
  }
})
test('promotion selects the original published candidate instead of rebuilding', () => {
  assert.equal(validateReleaseTarget({ ...target, operation: 'promote', release: { prerelease: true } }).operation, 'promote')
  for (const release of [null, { draft: true, prerelease: true }, { prerelease: false }]) {
    assert.throws(() => validateReleaseTarget({ ...target, operation: 'promote', release }))
  }
})
test('only an actual 404 permits a new build; API failures cannot masquerade as missing releases', async () => {
  assert.equal(await readRelease('TokensAPI/TokensCowork', target.tag, 'fixture', async () => ({ status: 404 })), null)
  for (const status of [401, 403, 429, 500]) await assert.rejects(readRelease('TokensAPI/TokensCowork', target.tag, 'fixture', async () => ({ status, ok: false })), new RegExp(`HTTP ${status}`))
  await assert.rejects(readRelease('bad/repo/extra', target.tag, 'fixture'), /Invalid/)
})
