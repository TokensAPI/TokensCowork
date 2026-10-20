import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createD1Database, createAssets, createTarballCache } from '../runtime/adapters.mjs'

const migrations = resolve(import.meta.dirname, '../database/migrations')

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
  const page = await assets.fetch('https://market.example/admin/')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('cache-control'), 'no-store')
  const csp = page.headers.get('content-security-policy')
  assert.ok(csp.includes("default-src 'self'"))
  // The self-hosted server and the Pages _headers file must send the same policy. data: is allowed
  // for images only (Swagger UI's icons); scripts and styles stay same-origin.
  assert.equal(csp, /Content-Security-Policy: (.+)/u.exec(readFileSync(resolve(import.meta.dirname, '../_headers'), 'utf8'))[1].trim())
  assert.match(csp, /img-src 'self' data:;/u)
  assert.match(csp, /script-src 'self';.*style-src 'self';/u)
  const manifest = await assets.fetch('https://market.example/source.json')
  assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal((await manifest.json()).manifestVersion, '1.0.0')
  assert.equal((await assets.fetch('https://market.example/%2e%2e/registry/config.yaml')).status, 404)
  assert.equal((await assets.fetch('https://market.example/package.json')).status, 200)
})
