import assert from 'node:assert/strict'
import test from 'node:test'

import { requiredReleaseSections, validateReleaseNotes } from './validate-release-notes.mjs'

function validNotes(version = '0.1.0') {
  return [
    `# TokensHarness v${version}`,
    '',
    'Summary.',
    '',
    ...requiredReleaseSections.flatMap(section => [`## ${section}`, '', 'Complete content.', '']),
  ].join('\n')
}

test('accepts complete release notes for the requested version', () => {
  assert.deepEqual(validateReleaseNotes({ content: validNotes(), version: '0.1.0' }), [])
})

test('rejects title, section, placeholder, and planning residue errors', () => {
  const content = validNotes('0.2.0')
    .replace('## 下载说明\n\nComplete content.\n', '')
    .replace('Summary.', '{{SUMMARY}} TODO')
  const errors = validateReleaseNotes({ content, version: '0.1.0' })
  assert.ok(errors.includes('first line must be: # TokensHarness v0.1.0'))
  assert.ok(errors.includes('missing required section: ## 下载说明'))
  assert.ok(errors.includes('template placeholders must be resolved'))
  assert.ok(errors.includes('TODO/TBD markers are not allowed'))
})
