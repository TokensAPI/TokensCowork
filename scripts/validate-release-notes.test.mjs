import assert from 'node:assert/strict'
import test from 'node:test'

import { requiredReleaseSections, validateReleaseNotes } from './validate-release-notes.mjs'

function validNotes(version = '0.1.0') {
  return [
    `# TokensCowork v${version}`,
    '',
    'Summary.',
    '',
    ...requiredReleaseSections.flatMap(section => [`## ${section}`, '', 'Complete content.', '']),
  ].join('\n')
}

test('accepts complete release notes for the requested version', () => {
  assert.deepEqual(validateReleaseNotes({ content: validNotes(), version: '0.1.0' }), [])
})

test('rejects channel-dependent or boilerplate introductions', () => {
  for (const summary of [
    '本预发布版本修复启动失败。', '本正式版本升级运行时。',
    '本版本新增插件市场。', '本次更新引入授权管理。',
    '本次为紧急修复版本：修复会话失败。',
    '作为预发布候选提供新的插件功能。', 'This pre-release fixes startup.',
  ]) {
    const errors = validateReleaseNotes({ content: validNotes().replace('Summary.', summary), version: '0.1.0' })
    assert.ok(errors.some(error => error.startsWith('summary must describe')), summary)
  }
})

test('accepts direct summaries and allows channel details outside the introduction', () => {
  const content = validNotes().replace('Summary.', '修复 v0.4.0 / v0.4.1 无法创建会话的问题，并新增授权管理。')
    .replace('## 下载说明', '## 下载说明\n\n预发布版本可在 GitHub 切换为正式版。')
  assert.deepEqual(validateReleaseNotes({ content, version: '0.1.0' }), [])
  assert.deepEqual(validateReleaseNotes({ content: content.replaceAll('\n', '\r\n'), version: '0.1.0' }), [])
})

test('requires an introduction before the detail headings', () => {
  const errors = validateReleaseNotes({ content: validNotes().replace('Summary.', ''), version: '0.1.0' })
  assert.ok(errors.includes('summary must contain a paragraph describing the changes'))
})

test('rejects title, section, placeholder, and planning residue errors', () => {
  const content = validNotes('0.2.0')
    .replace('## 下载说明\n\nComplete content.\n', '')
    .replace('Summary.', '{{SUMMARY}} TODO')
  const errors = validateReleaseNotes({ content, version: '0.1.0' })
  assert.ok(errors.includes('first line must be: # TokensCowork v0.1.0'))
  assert.ok(errors.includes('missing required section: ## 下载说明'))
  assert.ok(errors.includes('template placeholders must be resolved'))
  assert.ok(errors.includes('TODO/TBD markers are not allowed'))
})
