import assert from 'node:assert/strict'
import test from 'node:test'
import { retentionPlan } from './prune-legacy-releases.mjs'
test('retention uses numeric versions, excludes drafts and never removes 0.4 or later', () => {
  const tags = ['v0.3.9', 'v0.3.21', 'v0.3.20', 'v0.3.19', 'v0.4.0', 'v0.5.14']
  const releases = tags.map(tag_name => ({ tag_name, draft: false }))
  releases.push({ tag_name: 'v0.3.22', draft: true })
  const files = [...tags, 'v0.3.18', 'v0.3.22'].map(tag => `${tag}.md`)
  const plan = retentionPlan(releases, files)
  assert.deepEqual(plan.keep, ['v0.3.21', 'v0.3.20', 'v0.3.19'])
  assert.deepEqual(plan.removeReleases, ['v0.3.9'])
  assert.deepEqual(plan.removeDocs, ['v0.3.9.md', 'v0.3.18.md'])
})
