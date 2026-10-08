import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'
const { compareVersions, selectLanguage, introduction } = createRequire(import.meta.url)('../download/release-notes.js')
test('promotion timestamps cannot reorder versions and numeric suffixes sort correctly', () => {
  const tags = ['v0.5.9', 'v0.5.14', 'v0.5.10', 'v0.5.14-rc.10', 'v0.5.14-rc.2']
  assert.deepEqual(tags.sort((a, b) => compareVersions(b, a)), ['v0.5.14', 'v0.5.14-rc.10', 'v0.5.14-rc.2', 'v0.5.10', 'v0.5.9'])
})
test('bilingual notes display one language and both summaries remain readable', () => {
  const body = '# TokensCowork v0.5.14\n\n中文摘要。\n\n[中文](#本次更新) | [English](#whats-new)\n\n## 本次更新\n\n- 中文变化\n\n---\n\n## What\'s New\n\nEnglish summary.\n\n### Bug Fixes\n\n- English change\n\n<!-- tokenscowork:distribution=bundled -->'
  assert.ok(!selectLanguage(body, 'zh').includes('English'))
  assert.ok(!selectLanguage(body, 'en').includes('中文'))
  assert.equal(introduction(body, 'zh'), '中文摘要。')
  assert.equal(introduction(body.replaceAll('\n', '\r\n'), 'en'), 'English summary.')
  assert.equal(introduction('# TokensCowork v0.1.0\n\n旧说明。', 'en'), '旧说明。')
})


test('GitHub language anchors do not leak into download notes or summaries', () => {
  const body = '# TokensCowork v0.5.14\n\n中文摘要。\n\n[中文](#user-content-release-notes-zh) | [English](#user-content-release-notes-en)\n\n<a name="release-notes-zh"></a>\n\n## 本次更新\n\n- 中文变化\n\n---\n\n<a name="release-notes-en"></a>\n\n## What\'s New\n\nEnglish summary.'
  for (const language of ['zh', 'en']) {
    assert.ok(!selectLanguage(body, language).includes('<a '))
    assert.ok(!selectLanguage(body, language).includes('#user-content-'))
  }
  assert.equal(introduction(body, 'zh'), '中文摘要。')
  assert.equal(introduction(body, 'en'), 'English summary.')
})
