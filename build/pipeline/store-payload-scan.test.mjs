import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { invalidReason, prepareStorePayload, PRUNE, scanPayload } from './store-payload-scan.mjs'

test('names MakeAppx rejects are flagged, ordinary names pass', () => {
  for (const name of ['[Content_Types].xml', 'aux.py', 'NUL', 'com1.txt', 'name.', 'name ', 'a?b']) assert.ok(invalidReason(name), name)
  for (const name of ['GMT+0', '@isaacs', 'auxiliary.py', 'console.log', 'default.docx', 'file (1).txt', 'tempfile.cpython-312.pyc']) {
    assert.equal(invalidReason(name), null, name)
  }
})

test('store payload copy drops the known unused python-docx template source and leaves the EXE tree alone', () => {
  const source = mkdtempSync(join(tmpdir(), 'store-payload-'))
  const template = join(source, PRUNE[0].path)
  mkdirSync(join(template, 'word'), { recursive: true })
  writeFileSync(join(template, '[Content_Types].xml'), '<Types/>')
  writeFileSync(join(source, 'TokensCowork.exe'), 'MZ')
  assert.deepEqual(scanPayload(source).map(item => item.path), [`${PRUNE[0].path}/[Content_Types].xml`])
  const target = join(source, '..', `${source.split(/[\\/]/u).pop()}-store`)
  const result = prepareStorePayload(source, target)
  assert.deepEqual(result.pruned, [PRUNE[0].path])
  assert.deepEqual(result.invalid, [])
  assert.ok(existsSync(join(target, 'TokensCowork.exe')))
  assert.ok(existsSync(join(template, '[Content_Types].xml')), 'the EXE program directory is not modified')
})

test('an unknown invalid name is reported, not silently dropped', () => {
  const source = mkdtempSync(join(tmpdir(), 'store-payload-'))
  writeFileSync(join(source, 'aux.js'), '')
  const result = prepareStorePayload(source, `${source}-store`)
  assert.deepEqual(result.invalid, [{ path: 'aux.js', reason: 'Windows reserved device name' }])
})
