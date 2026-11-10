import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  deleteSession,
  encodeSegment,
  projectKey,
  SessionDeleteError,
  sessionDirectory,
  subagentDescendants,
  validSessionId,
} from './assets/session-delete-core.ts'

test('path keys match the JSONL backend on directories it really wrote', () => {
  // Both observed on disk under a real DSH 0.2.1-rc.2 Host.
  assert.equal(projectKey('C:\\Users\\wzm\\AppData\\Local\\Temp\\tokens-session-delete-smoke-dfmINI\\project'),
    '--C-Users-wzm-AppData-Local-Temp-tokens-session-delete-smoke-dfmINI-project--')
  assert.equal(projectKey('C:\\Users\\wzm\\测试'), '--C-Users-wzm-~6D4B~8BD5--')
  assert.equal(projectKey('/'), '--root--')
  assert.equal(encodeSegment('session-0b939253-473f-4614-b006-422af026de16'), 'session-0b939253-473f-4614-b006-422af026de16')
  assert.equal(encodeSegment('a~b c'), 'a~007Eb~0020c')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('the Session directory always sits exactly two levels under the root', () => {
  const root = resolve('/sessions-root')
  assert.equal(sessionDirectory(root, { id: 'session-1', cwd: '/work/app' }), join(root, '--work-app--', 'session-1'))
  assert.equal(sessionDirectory(root, { id: 'session-1' }), join(root, '_no-cwd', 'session-1'))
  assert.equal(sessionDirectory(root, { id: '../../etc', cwd: '/x' }), join(root, '--x--', '..~002F..~002Fetc'))
})

test('only ids the backend could have written are accepted', () => {
  for (const ok of ['session-1', 'session-0b939253-473f-4614-b006-422af026de16']) assert.ok(validSessionId(ok), ok)
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(257), 42, undefined, null]) assert.ok(!validSessionId(bad), String(bad))
})

test('subagent descendants come deepest first and forks are not included', () => {
  const headers = [
    { id: 'child', parentSession: 'root', origin: 'subagent' },
    { id: 'grandchild', parentSession: 'child', origin: 'subagent' },
    { id: 'fork', parentSession: 'root' },
    { id: 'other', parentSession: 'elsewhere', origin: 'subagent' },
  ]
  assert.deepEqual(subagentDescendants('root', headers), ['grandchild', 'child'])
})

/** A Host fake that records the order of every call. */
function fakeHost(overrides = {}) {
  const calls = []
  const stored = new Map([['s1', { id: 's1', cwd: '/w' }], ['sub', { id: 'sub', cwd: '/w', parentSession: 's1', origin: 'subagent' }]])
  const live = new Set(['s1'])
  let clock = 0
  const host = {
    root: resolve('/root'),
    calls,
    stored,
    live,
    list: async () => [...stored.values()],
    stat: async id => stored.get(id),
    liveHeader: id => (live.has(id) ? stored.get(id) : undefined),
    archive: async (id) => { calls.push(`archive:${id}`) },
    activity: async () => [],
    running: () => false,
    attached: id => live.has(id),
    release: async (id) => { calls.push(`release:${id}`); const had = live.delete(id); return had ? 'released' : 'absent' },
    claimWriter: async (id) => { calls.push(`claim:${id}`) },
    entries: async () => ['session.v4.jsonl.zstd'],
    removeDirectory: async (path) => {
      calls.push(`rm:${path}`)
      for (const [id] of stored) if (path.endsWith(id)) stored.delete(id)
    },
    forget: async (id) => { calls.push(`forget:${id}`) },
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    warn: (message) => { calls.push(`warn:${message.slice(0, 30)}`) },
    ...overrides,
  }
  return host
}

test('archive, release, write claim, removal, then registry cleanup — children before the parent', async () => {
  const host = fakeHost()
  const result = await deleteSession(host, 's1')
  assert.deepEqual(result.deleted, ['s1', 'sub'])
  const dir = id => `rm:${sessionDirectory(host.root, host.stored.get(id) ?? { id, cwd: '/w' })}`
  assert.deepEqual(host.calls, [
    'archive:s1',
    'release:sub', 'release:s1',
    'claim:sub', 'claim:s1',
    dir('sub'), dir('s1'),
    'forget:sub', 'forget:s1',
  ])
})

test('work that does not stop in time leaves the Session archived and untouched', async () => {
  const host = fakeHost({ running: () => true })
  await assert.rejects(deleteSession(host, 's1', { stopTimeoutMs: 300, pollMs: 100 }), error => error instanceof SessionDeleteError && error.code === 'busy')
  assert.deepEqual(host.calls, ['archive:s1'])
})

test('reported activity also blocks until it clears', async () => {
  let polls = 0
  const host = fakeHost({ activity: async () => (++polls < 3 ? [{ kind: 'job' }] : []) })
  await deleteSession(host, 's1', { pollMs: 10 })
  assert.equal(polls, 3)
})

test('a live Agent without a retained handle refuses before anything is removed', async () => {
  const host = fakeHost({ release: async () => 'unowned' })
  await assert.rejects(deleteSession(host, 's1'), error => error.code === 'owned')
  assert.ok(!host.calls.some(call => call.startsWith('rm:') || call.startsWith('forget:')))
})

test('another writer process holding the lease refuses', async () => {
  const owned = Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' })
  const host = fakeHost({ claimWriter: async () => { throw owned } })
  await assert.rejects(deleteSession(host, 's1'), error => error.code === 'owned' && error.cause === owned)
  assert.ok(!host.calls.some(call => call.startsWith('rm:')))
})

test('a write claim the backend cannot serve is logged, not fatal', async () => {
  const host = fakeHost({ claimWriter: async () => { throw new Error('format unsupported') } })
  assert.deepEqual((await deleteSession(host, 's1')).deleted, ['s1', 'sub'])
  assert.ok(host.calls.some(call => call.startsWith('warn:')))
})

test('a teardown failure after the Agent detached does not stop the deletion', async () => {
  const host = fakeHost()
  host.release = async (id) => { host.live.delete(id); throw new Error('ENOENT') }
  assert.deepEqual((await deleteSession(host, 's1')).deleted, ['s1', 'sub'])
})

test('a teardown failure that leaves the Session attached refuses', async () => {
  const host = fakeHost({ release: async () => { throw new Error('stuck') } })
  await assert.rejects(deleteSession(host, 's1'), error => error.code === 'owned')
})

test('a directory without a Session log is never removed', async () => {
  const host = fakeHost({ entries: async () => ['notes.txt'] })
  await assert.rejects(deleteSession(host, 's1'), error => error.code === 'storage')
  assert.ok(!host.calls.some(call => call.startsWith('rm:')))
})

test('storage still listing the Session after removal is a failure', async () => {
  const host = fakeHost({ removeDirectory: async () => {} })
  await assert.rejects(deleteSession(host, 's1'), error => error.code === 'remove-failed')
  assert.ok(!host.calls.some(call => call.startsWith('forget:')))
})

test('an unknown or already deleted id only finishes the registry cleanup', async () => {
  const host = fakeHost()
  assert.deepEqual((await deleteSession(host, 'gone')).deleted, [])
  assert.deepEqual(host.calls, ['forget:gone'])
})

test('a subagent Session and an invalid id are refused up front', async () => {
  const host = fakeHost()
  await assert.rejects(deleteSession(host, 'sub'), error => error.code === 'subagent')
  await assert.rejects(deleteSession(host, '../x'), error => error.code === 'invalid-id')
  assert.deepEqual(host.calls, [])
})
