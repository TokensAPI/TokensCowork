import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPatchRows, hasDynamicConfig } from '../lib/patch-rows.mjs'

test('insert 结构与顶层数组都能提取行', () => {
  const inserted = extractPatchRows(`- insert:
    - id: a
      name: '@x/a'
    - id: b
      name: '@x/b'
      disabled: true
`)
  assert.deepEqual(inserted.rows.map(row => row.name), ['@x/a', '@x/b'])
  assert.equal(inserted.rows[1].disabled, true)
  const flat = extractPatchRows(`- id: only
  name: '@x/only'
`)
  assert.deepEqual(flat.rows.map(row => row.name), ['@x/only'])
})

test('未知标签不致命,行照常提取且配置标记为动态', () => {
  const result = extractPatchRows(`- insert:
    - id: dyn
      name: '@x/dyn'
      config:
        secret: !env MY_TOKEN
`)
  assert.deepEqual(result.problems, [])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].dynamicConfig, true)
  assert.equal(hasDynamicConfig({ plain: { nested: 1 } }), false)
})

test('group 嵌套递归展开', () => {
  const result = extractPatchRows(`- insert:
    - id: outer
      group: true
      config:
        - id: inner
          name: '@x/inner'
`)
  assert.deepEqual(result.rows.map(row => row.name), ['@x/inner'])
})

test('坏 YAML 与缺 name 的行报 problem 而不是抛异常', () => {
  assert.ok(extractPatchRows('{oops').problems.length > 0)
  const missing = extractPatchRows(`- insert:
    - id: nameless
`)
  assert.equal(missing.rows.length, 0)
  assert.ok(missing.problems[0].includes('缺少 name'))
})
