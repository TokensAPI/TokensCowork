import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createLocalObjectStore, createS3ObjectStore, createSessionLogBindings } from '../runtime/session-log-storage.mjs'

// One contract for every object store the session logs can be kept in. A backend is only usable
// once it passes all of it; the business code relies on nothing else.
function storeContract(name, open, options = {}) {
  test(`${name}: put, get, list and delete behave as the session-log contract requires`, options, async t => {
    const store = await open(t)
    const bytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3])
    assert.equal(await store.get('session-logs/2026/10/s-1/4/-1-0.json.gz'), null)
    await store.put('session-logs/2026/10/s-1/4/-1-0.json.gz', bytes)
    await store.put('session-logs/2026/10/s-1/4/0-5.json.gz', new Uint8Array([9]))
    await store.put('session-logs/2026/10/s-10/4/-1-0.json.gz', new Uint8Array([7]))
    await store.put('session-logs/2026/11/s-2/4/-1-3.json.gz', new Uint8Array([8]))
    assert.deepEqual(await store.get('session-logs/2026/10/s-1/4/-1-0.json.gz'), bytes)
    // Replacing an object is allowed and leaves only the new bytes.
    await store.put('session-logs/2026/10/s-1/4/0-5.json.gz', new Uint8Array([10, 11]))
    assert.deepEqual(await store.get('session-logs/2026/10/s-1/4/0-5.json.gz'), new Uint8Array([10, 11]))
    // A prefix ending in "/" names one session and nothing that merely starts with the same letters.
    assert.deepEqual(await store.list('session-logs/2026/10/s-1/'), [
      'session-logs/2026/10/s-1/4/-1-0.json.gz', 'session-logs/2026/10/s-1/4/0-5.json.gz'])
    assert.equal((await store.list('session-logs/2026/')).length, 4)
    assert.deepEqual(await store.list('session-logs/2027/'), [])
    await store.delete('session-logs/2026/10/s-1/4/-1-0.json.gz')
    await store.delete('session-logs/2026/10/s-1/4/-1-0.json.gz')
    assert.equal(await store.get('session-logs/2026/10/s-1/4/-1-0.json.gz'), null)
    assert.deepEqual(await store.list('session-logs/2026/10/s-1/'), ['session-logs/2026/10/s-1/4/0-5.json.gz'])
    for (const key of ['../escape.json.gz', 'session-logs/../x', '/absolute', 'a//b', 'a\\b', ''])
      await assert.rejects(store.put(key, bytes), /Invalid object key/u, key)
  })
}

const scratch = async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'market-session-log-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

storeContract('local disk store', async t => createLocalObjectStore(await scratch(t)))
// The S3-compatible store is a stub until it is implemented: the contract is reported as skipped,
// never as passed.
storeContract('S3-compatible store', () => createS3ObjectStore({}), { skip: 'S3 兼容实现尚未完成（仅桩），契约未执行' })

test('local store removes folders a deletion leaves empty', async t => {
  const dir = await scratch(t)
  const store = createLocalObjectStore(dir)
  await store.put('session-logs/2026/10/s-1/4/-1-0.json.gz', new Uint8Array([1]))
  await store.delete('session-logs/2026/10/s-1/4/-1-0.json.gz')
  assert.deepEqual(await readdir(dir), [])
})

test('the configured backend is chosen from the environment and an unfinished one refuses to start', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'market-session-log-bindings-'))
  const migrations = resolve(import.meta.dirname, '../database/session-log-migrations')
  assert.deepEqual(createSessionLogBindings({ MARKET_SESSION_LOG_STORAGE: 'off' }, dir, migrations), {})
  const local = createSessionLogBindings({}, dir, migrations)
  // The index file has to be closed before its folder can go (Windows holds it open otherwise).
  t.after(async () => { local.MARKET_SESSION_LOG_DB.close(); await rm(dir, { recursive: true, force: true }) })
  assert.ok(local.MARKET_SESSION_LOG_STORE && local.MARKET_SESSION_LOG_DB)
  // The index is a file of its own beside the objects, never market.sqlite.
  assert.deepEqual((await readdir(resolve(dir, 'session-logs'))).filter(name => !name.includes('-')).sort(), ['index.sqlite', 'objects'])
  assert.throws(() => createSessionLogBindings({ MARKET_SESSION_LOG_STORAGE: 's3' }, dir, migrations), /needs endpoint/u)
  assert.throws(() => createSessionLogBindings({ MARKET_SESSION_LOG_STORAGE: 's3', MARKET_SESSION_LOG_S3_ENDPOINT: 'https://oss.example',
    MARKET_SESSION_LOG_S3_BUCKET: 'b', MARKET_SESSION_LOG_S3_ACCESS_KEY_ID: 'id', MARKET_SESSION_LOG_S3_SECRET_ACCESS_KEY: 'secret' },
  dir, migrations), /not implemented/u)
  assert.throws(() => createSessionLogBindings({ MARKET_SESSION_LOG_STORAGE: 'ftp' }, dir, migrations), /local, s3 or off/u)
})
