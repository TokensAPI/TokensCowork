import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePlugins, filterPlugins } from '../admin/assets/market-model.js'

const plugin = (id, fields = {}) => ({ id, displayName: id, package: '@example/' + id, summary: 'Plugin ' + id, version: '2.0.0', visibility: 'public', ...fields })

test('lifecycle filters hide trash by default and keep each stage separate', () => {
  const list = ['draft', 'published', 'archived', 'deleted'].map(state => plugin(state, { state }))
  assert.deepEqual(filterPlugins(mergePlugins({ items: list })).map(p => p.id), ['draft', 'published', 'archived'])
  for (const state of ['draft', 'published', 'archived', 'deleted'])
    assert.deepEqual(filterPlugins(mergePlugins({ items: list }), { stage: state }).map(p => p.id), [state])
})

test('product components are read-only, deduplicated and never restricted', () => {
  const component = plugin('core')
  const result = mergePlugins({ components: { productVersion: '1.2.3', items: [component] },
    items: [{ ...component, state: 'published' }, plugin('duplicate', { package: component.package }), plugin('tool', { state: 'published', visibility: 'restricted' })] })
  assert.deepEqual(result.map(p => [p.id, p.category, p.state]), [['core', 'builtin', 'builtin'], ['tool', 'optional', 'published']])
  assert.equal(result[0].productVersion, '1.2.3')
  assert.deepEqual(filterPlugins(result, { stage: 'builtin' }).map(p => p.id), ['core'])
  assert.deepEqual(filterPlugins(result, { visibility: 'restricted' }).map(p => p.id), ['tool'])
  assert.deepEqual(filterPlugins(result, { visibility: 'public' }).map(p => p.id), ['core'])
})

test('search matches name, id, package and summary', () => {
  const list = mergePlugins({ items: [plugin('alpha', { state: 'draft', summary: 'Finance tools' }), plugin('beta', { state: 'draft' })] })
  assert.deepEqual(filterPlugins(list, { query: 'finance' }).map(p => p.id), ['alpha'])
  assert.deepEqual(filterPlugins(list, { query: '@example/beta' }).map(p => p.id), ['beta'])
})

test('empty data is safe during session restoration', () => {
  assert.deepEqual(mergePlugins(undefined), [])
  assert.deepEqual(filterPlugins(undefined), [])
})
