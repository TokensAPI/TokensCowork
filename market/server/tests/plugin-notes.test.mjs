import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import worker from '../_worker.js'
import { createAssets } from '../runtime/adapters.mjs'
import { resetTestCatalog, seedTestPlugin } from './catalog-fixture.mjs'
import { changelogSection, clip, compareVersions, MAX_NOTE_LENGTH, noteText, versionNotes } from '../services/plugin-notes.js'

// Independent fixtures: the npm Registry is answered here from fictional packages, never contacted.
const ORIGIN = 'https://market.example'
const plugin = (id, version = '1.2.0') => ({ id, package: '@example/' + id, displayName: id, summary: id + ' summary', repository: '', version, npm: true, registry: 'npm' })
const IDENTITIES = {
  'sk-org-one': { organization: { id: 1, name: 'One' }, user: { id: 101, name: 'Alice' } },
  'sk-org-two': { organization: { id: 2, name: 'Two' }, user: { id: 202, name: 'Bob' } },
}

/** A package archive the way npm packs one: every file under package/. */
function tgz(files) {
  const blocks = []
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body), header = Buffer.alloc(512)
    header.write(name, 0); header.write('0000644\0', 100); header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('ustar\0', 257); header.write('00', 263); header[156] = 48
    header.fill(' ', 148, 156)
    header.write(([...header].reduce((a, b) => a + b, 0)).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, data, Buffer.alloc(-data.length & 511))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

const CHANGELOG = `# 更新记录

## [Unreleased]

- 尚未发布的改动

## [1.2.0] - 2026-11-20

### 新增

- 支持 **批量导出**，见 [文档](https://example.com/docs)。
- 新增 \`--dry-run\` 选项

## 1.1.0

- 修复登录失效的问题

## [1.0.0] - 2026-10-01

- 首个正式版
`
const CHANGELOG_EN = `# Changelog

## [1.2.0] - 2026-11-20

- Bulk export
- New \`--dry-run\` option

## [1.1.0]

- Fixed expired sign-in
`
// Versions of each fictional package, oldest first; public-tool ships both changelogs, every package
// but many-tool's has one.
const PACKAGES = {
  '@example/public-tool': { versions: ['0.9.0', '1.0.0', '1.1.0-beta.1', '1.1.0', '1.2.0'], files: { 'package/CHANGELOG.md': CHANGELOG, 'package/CHANGELOG.en.md': CHANGELOG_EN } },
  '@example/org-one-tool': { versions: ['1.0.0', '1.2.0'], files: { 'package/CHANGELOG.md': CHANGELOG } },
  '@example/many-tool': { versions: Array.from({ length: 25 }, (_, i) => `2.0.${i}`), files: {} },
}

function registry(t) {
  const archives = []
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.origin !== 'https://registry.npmjs.org') throw new Error('unexpected request ' + url)
    const tarball = /^\/(@example\/[a-z-]+)\/-\/[a-z-]+-(.+)\.tgz$/u.exec(decodeURIComponent(url.pathname))
    if (tarball) {
      archives.push(`${tarball[1]}@${tarball[2]}`)
      return new Response(tgz({ 'package/package.json': JSON.stringify({ name: tarball[1], version: tarball[2] }), ...PACKAGES[tarball[1]].files }))
    }
    const tags = /^\/-\/package\/(.+)\/dist-tags$/u.exec(decodeURIComponent(url.pathname))
    if (tags) return PACKAGES[tags[1]] ? Response.json({ latest: PACKAGES[tags[1]].versions.at(-1) }) : new Response('not found', { status: 404 })
    const name = decodeURIComponent(url.pathname.slice(1))
    const pkg = PACKAGES[name]
    if (!pkg) return new Response('not found', { status: 404 })
    const short = name.split('/')[1]
    return Response.json({
      name, 'dist-tags': { latest: pkg.versions.at(-1) },
      time: Object.fromEntries(pkg.versions.map((version, i) => [version, new Date(Date.UTC(2026, 0, 1 + i)).toISOString()])),
      versions: Object.fromEntries(pkg.versions.map(version => [version, { name, version,
        dist: { tarball: `https://registry.npmjs.org/${name}/-/${short}-${version}.tgz` } }])),
    })
  })
  return archives
}

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  resetTestCatalog(db, plugin('public-tool'))
  seedTestPlugin(db, plugin('org-one-tool'))
  seedTestPlugin(db, plugin('many-tool', '2.0.24'))
  seedTestPlugin(db, plugin('draft-tool'), 'draft')
  db.exec("UPDATE market_plugins SET visibility='restricted',revision=revision+1 WHERE id='org-one-tool'")
  db.exec("INSERT INTO market_organizations(id,name,enabled) VALUES(1,'One',1),(2,'Two',1)")
  db.exec("INSERT INTO market_grants(plugin_id,kind,subject) VALUES('org-one-tool','org','1')")
  t.after(() => db.close())
  const wrap = (sql, values = []) => ({ bind: (...v) => wrap(sql, v), first: async () => db.prepare(sql).get(...values), all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) })
  const env = { MARKET_ADMIN_TOKEN: 'admin-secret', MARKET_HMAC_SECRET: 'separate-secret',
    MARKET_DB: { prepare: wrap, batch: async statements => { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } },
    ASSETS: createAssets(resolve(fileURLToPath(new URL('..', import.meta.url)))),
    MARKET_ORGANIZATIONS: {
      resolveIdentity: async key => IDENTITIES[key] ?? { organization: null, user: null },
      resolveAccount: async credential => credential.userId === 501 ? { id: 501, displayName: 'Owner' } : null,
      resolveMyOrg: async credential => credential.userId === 501 ? { id: 1, name: 'One', role: 100 } : null,
    } }
  const archives = registry(t)
  const call = (path, { key, data, method = data === undefined ? 'GET' : 'PUT', headers = {} } = {}) => worker.fetch(new Request(ORIGIN + path, { method,
    headers: { Origin: ORIGIN, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env, {})
  const notes = async (id, query, key) => {
    const response = await call(`/v1/plugins/${id}/notes?${query}`, { key })
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).items
  }
  const admin = (path, data, method) => call('/api/v1' + path, { key: 'admin-secret', data, method })
  return { db, env, call, notes, admin, archives }
}

/* ----------------------------- extraction ----------------------------- */

test('a version\'s section is found under "## [x.y.z] - date" or "## x.y.z", never under Unreleased', () => {
  assert.match(changelogSection(CHANGELOG, '1.2.0'), /批量导出/u)
  assert.doesNotMatch(changelogSection(CHANGELOG, '1.2.0'), /登录失效|尚未发布/u)
  assert.equal(changelogSection(CHANGELOG, '1.1.0').trim(), '- 修复登录失效的问题')
  // The last section runs to the end of the file.
  assert.equal(changelogSection(CHANGELOG, '1.0.0').trim(), '- 首个正式版')
  assert.equal(changelogSection(CHANGELOG, '0.9.0'), null)
  assert.equal(changelogSection(CHANGELOG, '1.2'), null)
  // "v" prefixes, links on the version, CRLF and a "## 1.2.0" inside a code block.
  assert.equal(changelogSection('## [v2.0.0](https://x.test/compare) (2026-01-01)\r\n\r\n- A\r\n## 1.0.0\r\n- B', '2.0.0').trim(), '- A')
  assert.equal(changelogSection('## 3.0.0\n```\n## 2.0.0\n```\n- C\n## 2.0.0\n- D', '3.0.0').includes('- C'), true)
  // 1.2.0 is not 1.2.0-beta.1, and a deeper heading does not end a section.
  assert.equal(changelogSection('## 1.2.0-beta.1\n- beta\n## 1.2.0\n### Fixed\n- E', '1.2.0'), '### Fixed\n- E')
})

test('a note keeps text and the safe Markdown subset only', () => {
  const text = noteText(`<p align="center"><img src="x.png"></p>
<!-- internal -->
### Added
* **Bulk** export, see [docs](https://example.com) and ![shot](a.png)
+ \`code\` &amp; more <script>alert(1)</script>
> quoted
---
\`\`\`js
run()
\`\`\`

[docs]: https://example.com
`)
  assert.equal(text, '**Added**\n- **Bulk** export, see docs and shot\n- `code` & more alert(1)\nquoted\nrun()')
  assert.equal(noteText('<div></div>\n\n'), null)
  assert.equal(noteText('a‮\u0007b\n\n\n\nc'), 'ab\n\nc')
})

test('Chinese text is the Chinese note, anything else the English one; long notes are cut', () => {
  const files = new Map([['main', CHANGELOG], ['en', CHANGELOG_EN]])
  assert.deepEqual(versionNotes(files, '1.1.0'), { zh: '- 修复登录失效的问题', en: '- Fixed expired sign-in' })
  assert.deepEqual(versionNotes(new Map([['main', CHANGELOG_EN]]), '1.2.0'), { zh: null, en: '- Bulk export\n- New `--dry-run` option' })
  assert.deepEqual(versionNotes(new Map([['en', CHANGELOG_EN]]), '9.9.9'), { zh: null, en: null })
  assert.deepEqual(versionNotes(new Map(), '1.0.0'), { zh: null, en: null })
  // The same language in both files: the first file keeps it.
  assert.equal(versionNotes(new Map([['main', '## 1.0.0\n- one'], ['en', '## 1.0.0\n- two']]), '1.0.0').en, '- one')

  const long = Array.from({ length: 400 }, (_, i) => `- 第 ${i} 条改动，说明文字`).join('\n')
  const cut = clip(long)
  assert.ok(cut.length <= MAX_NOTE_LENGTH)
  assert.ok(cut.endsWith('\n…'))
  assert.ok(!cut.slice(0, -2).endsWith('，'), 'cut at a line break')
  const notes = versionNotes(new Map([['main', '## 1.0.0\n' + long]]), '1.0.0')
  assert.equal(notes.zh, cut)
  assert.equal(clip('x'.repeat(10)), 'x'.repeat(10))
})

test('versions compare by Semantic Versioning precedence', () => {
  const sorted = ['1.0.0', '0.9.10', '1.0.0-rc.1', '1.0.0-beta.11', '1.0.0-beta.2', '0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '2.0.0+build']
    .sort(compareVersions)
  assert.deepEqual(sorted, ['0.9.9', '0.9.10', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '2.0.0+build'])
})

/* ----------------------------- GET /v1/plugins/{id}/notes ----------------------------- */

test('the app reads the versions after the installed one, newest first, from the packages\' changelogs', async t => {
  const { notes, archives } = fixture(t)
  const items = await notes('public-tool', 'from=0.9.0&to=1.2.0')
  // The pre-release is not part of a range; 0.9.0 (installed) is not either.
  assert.deepEqual(items.map(item => item.version), ['1.2.0', '1.1.0', '1.0.0'])
  assert.deepEqual(items[0], { version: '1.2.0', publishedAt: '2026-01-05T00:00:00.000Z',
    zh: '**新增**\n\n- 支持 **批量导出**，见 文档。\n- 新增 `--dry-run` 选项', en: '- Bulk export\n- New `--dry-run` option' })
  assert.deepEqual(items[2], { version: '1.0.0', publishedAt: '2026-01-02T00:00:00.000Z', zh: '- 首个正式版', en: null })
  assert.deepEqual(archives.sort(), ['@example/public-tool@1.0.0', '@example/public-tool@1.1.0', '@example/public-tool@1.2.0'])

  // Without from, the one version; read once and kept, so asking again reads no package.
  assert.deepEqual((await notes('public-tool', 'to=1.1.0')).map(item => [item.version, item.en]), [['1.1.0', '- Fixed expired sign-in']])
  assert.deepEqual(await notes('public-tool', 'from=1.0.0&to=1.1.0'), [items[1]])
  assert.equal(archives.length, 3)
  // A pre-release target, an empty range and a version that was never published.
  assert.deepEqual((await notes('public-tool', 'from=1.0.0&to=1.1.0-beta.1')).map(item => item.version), ['1.1.0-beta.1'])
  assert.deepEqual(await notes('public-tool', 'from=1.2.0&to=1.2.0'), [])
  assert.deepEqual(await notes('public-tool', 'to=3.0.0'), [])
})

test('a range answers at most 20 versions, the newest; a package without a changelog has no text', async t => {
  const { notes } = fixture(t)
  const items = await notes('many-tool', 'from=1.0.0&to=2.0.24')
  assert.equal(items.length, 20)
  assert.equal(items[0].version, '2.0.24')
  assert.equal(items.at(-1).version, '2.0.5')
  assert.ok(items.every(item => item.zh === null && item.en === null))
})

test('the notes are visible exactly where the plugin is, and not otherwise', async t => {
  const { call, notes } = fixture(t)
  // Public: with or without a Key. Restricted: only with a Key that holds it.
  assert.equal((await notes('public-tool', 'to=1.2.0')).length, 1)
  assert.equal((await notes('org-one-tool', 'to=1.2.0', 'sk-org-one'))[0].zh.includes('批量导出'), true)
  for (const [id, key] of [['org-one-tool', 'sk-org-two'], ['org-one-tool', undefined], ['no-such-tool', 'sk-org-one'], ['draft-tool', undefined], ['Bad_Id', undefined]]) {
    const response = await call(`/v1/plugins/${id}/notes?to=1.2.0`, { key })
    assert.equal(response.status, 404, `${id} ${key}`)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  }
  for (const query of ['', 'to=latest', 'to=1.2.0&from=x']) assert.equal((await call(`/v1/plugins/public-tool/notes?${query}`)).status, 400, query)
  assert.equal((await call('/v1/plugins/public-tool/notes?to=1.2.0', { method: 'POST', data: {} })).status, 405)
  const preflight = await call('/v1/plugins/public-tool/notes', { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/u)
  // The catalog itself is unchanged by the new route.
  const catalog = await (await call('/v1/plugins')).json()
  assert.ok(catalog.items.some(item => item.id === 'public-tool'))
  assert.equal((await call('/v1/plugins/public-tool')).status, 404)
})

test('the administrator\'s text wins per language, and clearing it falls back to the package', async t => {
  const { db, notes, admin } = fixture(t)
  const save = (data, version = '1.2.0') => admin(`/plugins/public-tool/notes/${version}`, data, 'PUT')
  const saved = await save({ zh: '  后台写的中文说明\r\n第二行  ' })
  assert.equal(saved.status, 200)
  const item = await saved.json()
  assert.deepEqual(item.admin, { zh: '后台写的中文说明\n第二行', en: null })
  assert.match(item.auto.zh, /批量导出/u)
  let [read] = await notes('public-tool', 'to=1.2.0')
  assert.equal(read.zh, '后台写的中文说明\n第二行')
  assert.equal(read.en, '- Bulk export\n- New `--dry-run` option')
  // A language left out keeps its text; one sent empty is cleared.
  await save({ en: 'Written in the console' })
  ;[read] = await notes('public-tool', 'to=1.2.0')
  assert.deepEqual([read.zh, read.en], ['后台写的中文说明\n第二行', 'Written in the console'])
  await save({ zh: '', en: null })
  ;[read] = await notes('public-tool', 'to=1.2.0')
  assert.match(read.zh, /批量导出/u)
  assert.equal(read.en, '- Bulk export\n- New `--dry-run` option')
  // A version whose package has nothing to say gets the administrator's text alone.
  await save({ en: 'Initial preview' }, '0.9.0')
  assert.deepEqual((await notes('public-tool', 'to=0.9.0'))[0], { version: '0.9.0', publishedAt: '2026-01-01T00:00:00.000Z', zh: null, en: 'Initial preview' })

  assert.deepEqual(db.prepare("SELECT target,details FROM market_audit_events WHERE action='plugin.notes.saved' ORDER BY id").all().map(row => [row.target, JSON.parse(row.details)]), [
    ['public-tool:1.2.0', { zh: true, en: false }], ['public-tool:1.2.0', { zh: true, en: true }], ['public-tool:1.2.0', { zh: false, en: false }], ['public-tool:0.9.0', { zh: false, en: true }],
  ])
})

/* ----------------------------- /api/v1/plugins/{id}/notes ----------------------------- */

test('the console lists the versions, reads the newest from its package, and the rest when opened', async t => {
  const { admin, archives } = fixture(t)
  const list = await (await admin('/plugins/public-tool/notes')).json()
  assert.deepEqual({ ...list, items: undefined }, { pluginId: 'public-tool', source: 'npm', package: '@example/public-tool', versionsAvailable: true, items: undefined })
  assert.deepEqual(list.items.map(item => item.version), ['1.2.0', '1.1.0', '1.0.0', '0.9.0'])
  assert.deepEqual(archives, ['@example/public-tool@1.2.0'])
  assert.ok(list.items[0].extractedAt > 0)
  assert.equal(list.items[1].extractedAt, null)
  const older = await (await admin('/plugins/public-tool/notes/1.1.0')).json()
  assert.deepEqual(older.auto, { zh: '- 修复登录失效的问题', en: '- Fixed expired sign-in' })
  assert.deepEqual(older.admin, { zh: null, en: null })
  assert.deepEqual(archives, ['@example/public-tool@1.2.0', '@example/public-tool@1.1.0'])

  assert.equal((await admin('/plugins/public-tool/notes/7.0.0')).status, 404)
  assert.equal((await admin('/plugins/public-tool/notes/latest')).status, 404)
  assert.equal((await admin('/plugins/no-such-tool/notes')).status, 404)
  assert.equal((await admin('/plugins/public-tool/notes', {}, 'PUT')).status, 405)
  // The draft plugin is the administrator's to describe before it is published.
  assert.equal((await admin('/plugins/draft-tool/notes')).status, 200)
})

test('saving notes is checked, and only the platform administrator may', async t => {
  const { call, admin } = fixture(t)
  const put = data => admin('/plugins/public-tool/notes/1.2.0', data, 'PUT')
  assert.equal((await put({})).status, 400)
  assert.equal((await put({ zh: 3 })).status, 400)
  assert.equal((await put({ en: 'x'.repeat(MAX_NOTE_LENGTH + 1) })).status, 400)
  assert.equal((await put({ zh: '长'.repeat(MAX_NOTE_LENGTH), en: 'y'.repeat(MAX_NOTE_LENGTH) })).status, 200)
  assert.equal((await admin('/plugins/public-tool/notes/8.8.8', { zh: '不存在的版本' }, 'PUT')).status, 404)

  const cookie = (await call('/api/v1/session', { data: { tokensapi: true, accessToken: 'owner-token', userId: 501 } })).headers.get('set-cookie').split(';')[0]
  for (const [method, path, data] of [['GET', '/notes'], ['GET', '/notes/1.2.0'], ['PUT', '/notes/1.2.0', { zh: '越权' }]])
    assert.equal((await call('/api/v1/plugins/public-tool' + path, { method, data, headers: { Cookie: cookie } })).status, 403)
  assert.equal((await call('/api/v1/plugins/public-tool/notes', { key: 'sk-org-one' })).status, 401)
})

test('while the Registry cannot be read, stored notes are still served', async t => {
  const { db, notes, admin } = fixture(t)
  db.exec("INSERT INTO market_plugin_notes(plugin_id,version,admin_zh,updated_at) VALUES('public-tool','1.1.0','已保存的说明',1)")
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  assert.deepEqual(await notes('public-tool', 'from=1.0.0&to=1.2.0'), [
    { version: '1.2.0', publishedAt: null, zh: null, en: null },
    { version: '1.1.0', publishedAt: null, zh: '已保存的说明', en: null },
  ])
  const list = await (await admin('/plugins/public-tool/notes')).json()
  assert.equal(list.versionsAvailable, false)
  assert.deepEqual(list.items.map(item => item.version), ['1.2.0', '1.1.0'])
  assert.equal((await admin('/plugins/public-tool/notes/1.0.0', { zh: 'x' }, 'PUT')).status, 503)
  assert.equal((await admin('/plugins/public-tool/notes/1.1.0', { zh: '改过' }, 'PUT')).status, 200)
})
