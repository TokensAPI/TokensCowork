import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import { createD1Database, createAssets, createTarballCache, chooseEncoding } from '../runtime/adapters.mjs'

const migrations = resolve(import.meta.dirname, '../database/migrations')

function mkdirs(root, dir) { mkdirSync(join(root, dir), { recursive: true }) }
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'market-host-'))
  // node:test runs after-hooks in FIFO order, so close database handles in the
  // test body; the removal tolerates a leaked handle on Windows.
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {} })
  return dir
}

test('the sqlite adapter honours the D1 contract and rolls batches back atomically', async t => {
  const dir = scratch(t)
  const db = createD1Database(join(dir, 'market.sqlite'), migrations)
  // Migrations replayed against an existing file are no-ops (idempotent seed).
  createD1Database(join(dir, 'market.sqlite'), migrations).close()
  const { results } = await db.prepare('SELECT id FROM market_plugins ORDER BY id').all()
  assert.ok(results.length >= 4)
  assert.equal(await db.prepare('SELECT id FROM market_plugins WHERE id=?').bind('missing').first(), null)
  await assert.rejects(db.batch([
    db.prepare('INSERT INTO market_keys(fingerprint,label,created_at) VALUES(?,?,0)').bind('a'.repeat(64), 'batch'),
    // Rejected by the foreign key: there is no such organization, so the batch must roll back.
    db.prepare('INSERT INTO market_org_hidden(organization_id,plugin_id) VALUES(?,?)').bind(4040, 'tokens-media-gen'),
  ]))
  assert.equal(await db.prepare('SELECT fingerprint FROM market_keys WHERE label=?').bind('batch').first(), null)
  db.close()
})

const archive = Buffer.from('fixture-archive-bytes')
const sri = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const key = name => `${encodeURIComponent(name)}-2.9.4`

function stream(bytes, chunks = 4) {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      const start = Math.floor((bytes.length * index) / chunks)
      const end = Math.floor((bytes.length * (index + 1)) / chunks)
      index += 1
      if (start >= bytes.length) return controller.close()
      controller.enqueue(new Uint8Array(bytes.subarray(start, end)))
    },
  })
}

async function drain(body) {
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('the archive cache answers a repeat download itself and keeps only verified complete archives', async t => {
  const dir = join(scratch(t), 'archives')
  const cache = createTarballCache(dir, { maxBytes: 30, maxEntryBytes: 64 })
  const verified = key('@tokensapi/dsh-connect')
  assert.equal(await cache.read(verified), undefined)
  // The bytes reach the client unchanged whether or not they end up cached.
  assert.deepEqual(await drain(cache.capture(verified, stream(archive), sri(archive))), archive)
  const cached = await cache.read(verified)
  assert.equal(cached.size, archive.length)
  assert.deepEqual(await drain(cached.body), archive)

  // A digest that does not match the Registry, a missing digest, an archive
  // over the entry budget and an abandoned download are all served and none
  // of them is kept.
  for (const [name, integrity] of [
    ['@tokensapi/mismatch', sri(Buffer.from('other bytes'))],
    ['@tokensapi/unverifiable', undefined],
    ['@tokensapi/oversize', sri(archive)],
  ]) {
    const limited = name.endsWith('oversize') ? createTarballCache(dir, { maxBytes: 30, maxEntryBytes: 4 }) : cache
    assert.deepEqual(await drain(limited.capture(key(name), stream(archive), integrity)), archive)
    assert.equal(await limited.read(key(name)), undefined, name)
  }
  const abandoned = cache.capture(key('@tokensapi/abandoned'), stream(archive), sri(archive)).getReader()
  await abandoned.read()
  await abandoned.cancel('client disconnected')
  assert.equal(await cache.read(key('@tokensapi/abandoned')), undefined)

  // A second archive passes the budget, so the oldest entry makes room.
  const next = Buffer.from('second-archive-bytes')
  await drain(cache.capture(key('@tokensapi/second'), stream(next), sri(next)))
  assert.deepEqual(readdirSync(dir), [`${key('@tokensapi/second')}.tgz`])

  // A key that is not a plain archive name never reaches the filesystem.
  for (const unsafe of ['../escape', 'name/with/slash', '']) {
    assert.deepEqual(await drain(cache.capture(unsafe, stream(archive), sri(archive))), archive)
    assert.equal(await cache.read(unsafe), undefined)
  }
  assert.deepEqual(readdirSync(dir), [`${key('@tokensapi/second')}.tgz`])
})

test('the assets adapter serves admin pages with the security headers and confines paths', async t => {
  const assets = createAssets(resolve(import.meta.dirname, '..'))
  const page = await assets.fetch('https://market.example/admin/docs.html')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('cache-control'), 'no-cache')
  const csp = page.headers.get('content-security-policy')
  assert.ok(csp.includes("default-src 'self'"))
  // The self-hosted server and the Pages _headers file must send the same policy. data: and blob:
  // are allowed for images only (Swagger UI's icons; documentation images the docs center fetches
  // with the reader's Key and shows as blob URLs); scripts and styles stay same-origin.
  assert.equal(csp, /Content-Security-Policy: (.+)/u.exec(readFileSync(resolve(import.meta.dirname, '../_headers'), 'utf8'))[1].trim())
  assert.match(csp, /img-src 'self' data: blob:;/u)
  assert.match(csp, /script-src 'self';.*style-src 'self';/u)
  const manifest = await assets.fetch('https://market.example/source.json')
  assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal((await manifest.json()).manifestVersion, '1.0.0')
  assert.equal((await assets.fetch('https://market.example/%2e%2e/registry/config.yaml')).status, 404)
  assert.equal((await assets.fetch('https://market.example/package.json')).status, 200)
})

const ADMIN = 'https://market.example'
const get = (assets, path, headers = {}) => assets.fetch(new Request(ADMIN + path, { headers }))
// What each answer sends that the console's security depends on; caching must not change any of it.
const security = response => ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'content-security-policy'].map(name => response.headers.get(name))

test('console files are compressed for browsers that accept it, and each says so', async () => {
  const assets = createAssets(resolve(import.meta.dirname, '..'))
  const original = readFileSync(resolve(import.meta.dirname, '../admin/assets/vendor/tabler/tabler.min.css'))
  const plain = await get(assets, '/admin/assets/vendor/tabler/tabler.min.css')
  assert.equal(plain.headers.get('content-encoding'), null)
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), original)
  const gzip = await get(assets, '/admin/assets/vendor/tabler/tabler.min.css', { 'accept-encoding': 'gzip, deflate' })
  assert.equal(gzip.headers.get('content-encoding'), 'gzip')
  assert.equal(gzip.headers.get('vary'), 'Accept-Encoding')
  const gzipped = Buffer.from(await gzip.arrayBuffer())
  assert.deepEqual(gunzipSync(gzipped), original)
  assert.ok(gzipped.length < original.length / 4, `gzip ${gzipped.length} of ${original.length}`)
  const br = await get(assets, '/admin/assets/market-docs.js', { 'accept-encoding': 'gzip, deflate, br, zstd' })
  assert.equal(br.headers.get('content-encoding'), 'br')
  assert.deepEqual(brotliDecompressSync(Buffer.from(await br.arrayBuffer())), readFileSync(resolve(import.meta.dirname, '../admin/assets/market-docs.js')))
  // The docs center page too; its security headers are untouched by compression.
  const page = await get(assets, '/admin/docs.html', { 'accept-encoding': 'gzip' })
  assert.deepEqual([page.headers.get('content-encoding'), page.headers.get('content-type')], ['gzip', 'text/html; charset=utf-8'])
  assert.deepEqual(security(page), security(await get(assets, '/admin/docs.html')))
  // Images and fonts are already compressed and are sent as they are.
  const font = await get(assets, '/admin/assets/fonts/Quicksand-Variable.ttf', { 'accept-encoding': 'gzip' })
  assert.deepEqual([font.headers.get('content-encoding'), font.headers.get('vary')], [null, null])
  // Files outside the console keep their old answer.
  const manifest = await get(assets, '/source.json', { 'accept-encoding': 'gzip' })
  assert.deepEqual([manifest.headers.get('content-encoding'), manifest.headers.get('etag'), manifest.headers.get('cache-control')], [null, null, null])
  assert.deepEqual([chooseEncoding(''), chooseEncoding('gzip;q=0, br;q=0'), chooseEncoding('gzip, br;q=0'), chooseEncoding('*'), chooseEncoding('identity')],
    ['', '', 'gzip', 'br', ''])
})

test('the console revalidates its own files, keeps vendor files a day, and answers 304 when nothing changed', async t => {
  const root = scratch(t)
  mkdirs(root, 'admin/assets/vendor/lib')
  writeFileSync(join(root, 'admin/index.html'), '<!doctype html><main>' + 'console '.repeat(100) + '</main>')
  writeFileSync(join(root, 'admin/assets/app.js'), 'export const app = 1\n'.repeat(40))
  writeFileSync(join(root, 'admin/assets/vendor/lib/lib.css'), 'body{color:red}\n'.repeat(40))
  const assets = createAssets(root)
  const own = await get(assets, '/admin/assets/app.js')
  const vendor = await get(assets, '/admin/assets/vendor/lib/lib.css')
  assert.equal(own.headers.get('cache-control'), 'no-cache')
  assert.equal(vendor.headers.get('cache-control'), 'public, max-age=86400')
  assert.match(own.headers.get('etag'), /^W\/"[A-Za-z0-9_-]{27}"$/u)
  // The same file, compressed or not, has one validator; an unchanged file is a 304 with no body
  // and the same caching and security headers.
  const etag = own.headers.get('etag')
  assert.equal((await get(assets, '/admin/assets/app.js', { 'accept-encoding': 'gzip' })).headers.get('etag'), etag)
  for (const tag of [etag, etag.slice(2), `"other", ${etag}`, '*']) {
    const again = await get(assets, '/admin/assets/app.js', { 'if-none-match': tag, 'accept-encoding': 'gzip' })
    assert.equal(again.status, 304, tag)
    assert.equal((await again.arrayBuffer()).byteLength, 0)
    assert.deepEqual([again.headers.get('cache-control'), again.headers.get('etag')], ['no-cache', etag])
    assert.deepEqual(security(again), security(own))
  }
  const vendor304 = await get(assets, '/admin/assets/vendor/lib/lib.css', { 'if-none-match': vendor.headers.get('etag') })
  assert.deepEqual([vendor304.status, vendor304.headers.get('cache-control')], [304, 'public, max-age=86400'])
  assert.equal((await get(assets, '/admin/assets/app.js', { 'if-none-match': 'W/"stale"' })).status, 200)
  // A release changes the file: the old validator no longer matches and the new content is served.
  writeFileSync(join(root, 'admin/assets/app.js'), 'export const app = 2\n'.repeat(40))
  utimesSync(join(root, 'admin/assets/app.js'), new Date(), new Date(Date.now() + 5000))
  const changed = await get(assets, '/admin/assets/app.js', { 'if-none-match': etag })
  assert.equal(changed.status, 200)
  assert.notEqual(changed.headers.get('etag'), etag)
  assert.match(await changed.text(), /app = 2/u)
  // The Pages _headers file says the same.
  const rules = readFileSync(resolve(import.meta.dirname, '../_headers'), 'utf8')
  assert.match(rules, /\/admin\/\*\s+Cache-Control: no-cache/u)
  assert.match(rules, /\/admin\/assets\/vendor\/\*\s+Cache-Control: public, max-age=86400/u)
})
