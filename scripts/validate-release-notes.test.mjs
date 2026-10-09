import assert from 'node:assert/strict'
import test from 'node:test'

import { requiredReleaseSections, validateReleaseNotes } from './validate-release-notes.mjs'
import { fullNotes } from './full-release-notes-fixture.mjs'

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

test('full template accepts filled bilingual notes and rejects incomplete structure', () => {
  const validate = content => validateReleaseNotes({ content, version: '0.5.14', fullTemplate: true })
  const notes = fullNotes()
  assert.deepEqual(validate(notes), [])
  assert.ok(validate(notes.replace('<a name="release-notes-en"></a>', '')).some(error => error.includes('language anchor')))
  assert.ok(validate(notes.replace('#user-content-release-notes-en', '#whats-new')).some(error => error.includes('language navigation')))

  assert.deepEqual(validate(notes.replaceAll('\n', '\r\n')), [])
  assert.ok(validate(notes.slice(0, notes.indexOf("## What's New"))).length > 0)
  assert.ok(validate(notes.replace('### 🐛 Bug Fixes', '### Not a category')).some(error => error.includes('both languages')))
  assert.ok(validate(notes.replaceAll('TokensCowork-0.5.14-windows', 'TokensCowork-0.5.13-windows')).some(error => error.includes('asset link')))
  assert.ok(!notes.includes('### 从旧版本升级'))
  assert.ok(!notes.includes('### Upgrading from an Earlier Version'))
  assert.ok(validate(notes.replace('### macOS Installation', '### Other')).some(error => error.includes('installation subsection')))
  assert.ok(validate(notes + '\n## 本次更新\n\nDuplicate.').some(error => error.includes('without duplicates')))
  assert.ok(validate(notes.replace(/## 已知限制[^]*?(?=## 完整变更)/, '## 已知限制\n\n')).some(error => error.includes('must contain content')))
})
