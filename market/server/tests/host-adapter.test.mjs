import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createD1Database, createPackagesStore, createAssets } from '../../host/adapters.mjs'

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
    db.prepare('INSERT INTO market_keys(fingerprint,label,enabled,expires_at) VALUES(?,?,1,NULL)').bind('a'.repeat(64), 'batch'),
    db.prepare('INSERT INTO market_grants(fingerprint,plugin_id) VALUES(?,?)').bind('b'.repeat(64), 'nonexistent-plugin'),
  ]))
  assert.equal(await db.prepare('SELECT fingerprint FROM market_keys WHERE label=?').bind('batch').first(), null)
  db.close()
})

test('the packages store refuses traversal and serves only whitelisted keys', async t => {
  const dir = scratch(t)
  mkdirSync(join(dir, 'packages/fixtures'), { recursive: true })
  writeFileSync(join(dir, 'packages/fixtures/test.tgz'), 'bytes')
  writeFileSync(join(dir, 'secret.txt'), 'outside')
  const store = createPackagesStore(join(dir, 'packages'))
  assert.equal(String((await store.get('fixtures/test.tgz')).body), 'bytes')
  for (const key of ['../secret.txt', 'fixtures/../../secret.txt', '/etc/passwd', 'fixtures//test.tgz', './fixtures/test.tgz', 'missing.tgz', 42]) {
    assert.equal(await store.get(key), null, String(key))
  }
})

test('the assets adapter serves admin pages with the security headers and confines paths', async t => {
  const assets = createAssets(resolve(import.meta.dirname, '..'))
  const page = await assets.fetch('https://market.example/admin/')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.ok(page.headers.get('content-security-policy').includes("default-src 'self'"))
  const manifest = await assets.fetch('https://market.example/source.json')
  assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal((await manifest.json()).manifestVersion, '1.0.0')
  assert.equal((await assets.fetch('https://market.example/%2e%2e/registry/config.yaml')).status, 404)
  assert.equal((await assets.fetch('https://market.example/package.json')).status, 200)
})
