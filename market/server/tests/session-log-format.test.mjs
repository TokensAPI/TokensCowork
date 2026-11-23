import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifySearch, sizeText, tokenText, relativeTime, shortKey, platformName, TIME_PRESETS } from '../admin/assets/market-session-log-format.js'

// The session-log list's wording (admin/assets/market-session-log-format.js) and the page structure
// its script relies on.

test('one search box stands for an account, a session or a Key', () => {
  assert.equal(classifySearch('   '), null)
  assert.deepEqual(classifySearch(' session-1111-2222 '), { field: 'session', value: 'session-1111-2222' })
  assert.deepEqual(classifySearch('sk-mx9tAbc'), { field: 'key', value: 'sk-mx9tAbc' })
  assert.deepEqual(classifySearch('535'), { field: 'account', value: '535' })
  // Hex digits are a Key fingerprint prefix; anything else is an account id, matched exactly.
  assert.deepEqual(classifySearch('a1b2c3d4'), { field: 'key', value: 'a1b2c3d4' })
  assert.deepEqual(classifySearch('alice@example'), { field: 'account', value: 'alice@example' })
})

test('sizes, token counts, Keys and platforms read the way the console writes them', () => {
  assert.deepEqual([0, 10, 145 * 1024, 25 * 1024 ** 2, 3 * 1024 ** 3].map(sizeText), ['0 KB', '1 KB', '145 KB', '25.0 MB', '3.0 GB'])
  assert.deepEqual([0, undefined, 9876, 601234, 37012345, 123456789].map(tokenText), ['—', '—', '9,876', '60.1 万', '3701.2 万', '1.2 亿'])
  assert.equal(shortKey('sk-mx9tQwertyuiopeAG7'), 'sk-mx9t…eAG7')
  assert.equal(shortKey('sk-short'), 'sk-short')
  assert.deepEqual(['win32', 'darwin', 'linux', 'freebsd', undefined].map(platformName), ['Windows', 'macOS', 'Linux', 'freebsd', ''])
  assert.deepEqual(Object.keys(TIME_PRESETS), ['24h', '7d', '30d'])
})

test('upload times are relative to now', () => {
  const now = new Date(2026, 10, 23, 15, 20).getTime()
  const at = (...parts) => new Date(...parts).getTime()
  assert.equal(relativeTime(null, now), '—')
  assert.equal(relativeTime(now - 20_000, now), '刚刚')
  assert.equal(relativeTime(now - 12 * 60_000, now), '12 分钟前')
  assert.equal(relativeTime(at(2026, 10, 23, 12, 5), now), '3 小时前')
  assert.equal(relativeTime(at(2026, 10, 22, 22, 34), now), '昨天 22:34')
  assert.equal(relativeTime(at(2026, 10, 20, 8, 5), now), '11月20日 08:05')
  assert.equal(relativeTime(at(2025, 11, 31, 23, 0), now), '2025/12/31')
  // Just after midnight, last night beyond the hour is 「昨天」, not hours ago.
  assert.equal(relativeTime(at(2026, 10, 22, 23, 0), at(2026, 10, 23, 0, 30)), '昨天 23:00')
})

test('every element the session-log scripts reach for exists on the page', () => {
  const page = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8')
  const ids = new Set([...page.matchAll(/\bid="([\w-]+)"/gu)].map(match => match[1]))
  for (const file of ['market-session-logs.js', 'market-session-log-detail.js']) {
    const source = readFileSync(new URL(`../admin/assets/${file}`, import.meta.url), 'utf8')
    for (const [, id] of source.matchAll(/\$\('([\w-]+)'\)/gu)) assert.ok(ids.has(id), `${file} uses #${id}, missing from index.html`)
  }
  // The retired layout is gone: no standing warning, no separate account / session / Key boxes.
  for (const id of ['session-log-account', 'session-log-session', 'session-log-key', 'session-log-selected'])
    assert.ok(!ids.has(id), `#${id} should be gone`)
  assert.ok(!/<div class="alert alert-warning">\s*日志<b>不脱敏<\/b>/u.test(page))
})
