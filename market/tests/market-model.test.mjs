import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePlugins, keyGrants, filterPlugins, parseKeys, effectiveNewKeys } from '../admin/assets/market-model.js'

test('database lifecycle filters hide trash by default and keep draft/published views separate',()=>{
 const list=['draft','published','archived','deleted'].map(state=>({id:state,category:'optional',state}))
 assert.deepEqual(filterPlugins(list,{},{}).map(p=>p.id),['draft','published','archived'])
 for(const state of ['draft','published','archived','deleted'])assert.deepEqual(filterPlugins(list,{}, {stage:state}).map(p=>p.id),[state])
})
test('built-in and ACL-only records never become editable market cards',()=>{
 assert.deepEqual(mergePlugins({items:[{id:'app-core',category:'builtin'}]}, {plugins:[{id:'stale',metadata:{id:'stale'}}]}),[])
})

const plugin = (id, fields = {}) => ({ id, displayName: id, package: '@example/' + id, summary: 'Plugin ' + id, version: '2.0.0', category: 'optional', ...fields })

test('release roster metadata wins over stale saved permission snapshots', () => {
  const roster = { items: [plugin('tool', { displayName: 'Current name', category: 'optional' })] }
  const state = { plugins: [{ id: 'tool', visibility: 'restricted', metadata: plugin('tool', { displayName: 'Old name', version: '1.0.0' }) }] }
  const original = structuredClone({ roster, state })
  const result = mergePlugins(roster, state)
  assert.deepEqual(result, roster.items)
  assert.notEqual(result[0], roster.items[0])
  assert.deepEqual({ roster, state }, original)
})

test('ACL-only records cannot resurrect missing catalog entries', () => {
  const roster = [plugin('released')]
  const state = { plugins: [
    { id: 'released', metadata: plugin('released', { version: '0.0.1' }) },
    { id: 'custom', metadata: plugin('spoofed-id', { category: 'builtin' }) },
    { id: 'custom', metadata: plugin('duplicate') },
  ] }
  const result = mergePlugins(roster, state)
  assert.deepEqual(result.map(item => item.id), ['released'])
  assert.equal(result[0].version, '2.0.0')
  assert.equal(result.length, 1)
})

test('empty data is safe during initial session restoration', () => {
  assert.deepEqual(mergePlugins(undefined), [])
  assert.deepEqual(keyGrants(undefined, 'tool', 1000), [])
  assert.deepEqual(filterPlugins(undefined, undefined), [])
  assert.deepEqual(parseKeys(null), [])
  assert.deepEqual(effectiveNewKeys(''), [])
})

test('legacy grants include only active unexpired keys for the target plugin', () => {
  const state = {
    keys: [
      { fingerprint: 'active', enabled: 1, expires_at: null },
      { fingerprint: 'future', enabled: true, expires_at: 1001 },
      { fingerprint: 'expired', enabled: 1, expires_at: 1000 },
      { fingerprint: 'disabled', enabled: 0, expires_at: null },
      { fingerprint: 'other', enabled: 1 },
    ],
    grants: ['active', 'active', 'future', 'expired', 'disabled', 'unknown']
      .map(fingerprint => ({ plugin_id: 'tool', fingerprint }))
      .concat({ plugin_id: 'another', fingerprint: 'other' }),
  }
  assert.deepEqual(keyGrants(state, 'tool', 1000), ['active', 'future'])
})

test('migrated policies use explicit grants and never reactivate legacy grants', () => {
  const state = {
    organizationPolicies: [{ plugin_id: 'tool' }],
    keys: [{ fingerprint: 'legacy', enabled: 1 }],
    grants: [{ plugin_id: 'tool', fingerprint: 'legacy' }],
    directKeyGrants: [
      { plugin_id: 'tool', fingerprint: 'direct' },
      { plugin_id: 'tool', fingerprint: 'direct' },
      { plugin_id: 'another', fingerprint: 'other' },
    ],
  }
  assert.deepEqual(keyGrants(state, 'tool', 1000), ['direct'])
  assert.deepEqual(keyGrants({ ...state, directKeyGrants: [] }, 'tool', 1000), [])
})

test('unmigrated policies do not unexpectedly expose leftover direct grants', () => {
  assert.deepEqual(keyGrants({ directKeyGrants: [{ plugin_id: 'tool', fingerprint: 'direct' }] }, 'tool', 1000), [])
})

test('category, visibility and case-insensitive search compose without mutating input', () => {
  const plugins = [plugin('builtin', { category: 'builtin' }), plugin('private', { displayName: 'Browser Tools' }), plugin('public')]
  const state = { plugins: [{ id: 'private', visibility: 'restricted' }] }
  const original = structuredClone(plugins)
  assert.deepEqual(filterPlugins(plugins, state, { query: ' BROWSER ', category: 'optional', visibility: 'restricted' }).map(item => item.id), ['private'])
  assert.deepEqual(filterPlugins(plugins, state, { query: '@example/public', visibility: 'public' }).map(item => item.id), ['public'])
  assert.deepEqual(filterPlugins(plugins, state, { query: 'absent' }), [])
  assert.deepEqual(plugins, original)
})

test('built-ins are never restricted even when legacy database metadata says otherwise', () => {
  const plugins = [plugin('builtin', { category: 'builtin' }), plugin('private')]
  const state = { plugins: plugins.map(item => ({ id: item.id, visibility: 'restricted' })) }
  assert.deepEqual(filterPlugins(plugins, state, { visibility: 'restricted' }).map(item => item.id), ['private'])
  assert.deepEqual(filterPlugins(plugins, state, { visibility: 'public' }).map(item => item.id), ['builtin'])
  assert.deepEqual(filterPlugins(plugins, state, { category: 'builtin', visibility: 'restricted' }), [])
})

test('search includes Chinese descriptions and category omission means optional', () => {
  const plugins = [plugin('tool', { category: undefined, summary: '企业图像生成' })]
  assert.equal(filterPlugins(plugins, {}, { category: 'optional', query: '图像' }).length, 1)
})

test('pasted keys are trimmed, line-deduplicated and remain case-sensitive', () => {
  assert.deepEqual(parseKeys('  sk-test-A\r\n\n sk-test-B \rsk-test-A\nsk-test-a\n'), ['sk-test-A', 'sk-test-B', 'sk-test-a'])
})

test('known saved plaintext duplicates are not counted as new keys', () => {
  const saved = ['sk-test-A', null, undefined]
  assert.deepEqual(effectiveNewKeys('sk-test-A\nsk-test-B\nsk-test-B', saved), ['sk-test-B'])
  assert.deepEqual(saved, ['sk-test-A', null, undefined])
  // Unknown legacy fingerprints cannot be compared to plaintext in the browser.
  assert.deepEqual(effectiveNewKeys('sk-test-A', []), ['sk-test-A'])
})

test('a removed saved key can be re-added by comparing only currently retained values', () => {
  const plaintext = new Map([['fingerprint-a', 'sk-test-A'], ['fingerprint-b', 'sk-test-B']])
  const retained = new Set(['fingerprint-b'])
  const retainedValues = [...retained].map(fingerprint => plaintext.get(fingerprint))
  assert.deepEqual(effectiveNewKeys('sk-test-A\nsk-test-B', retainedValues), ['sk-test-A'])
})
