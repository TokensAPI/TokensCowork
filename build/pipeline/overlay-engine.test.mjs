import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { AnchorError, replaceOnce, runOverlays, validateOverlays } from './overlay-engine.mjs'

const base = { module: 'runtime', phase: 'prepare', upstream: ['desktop'], kind: 'workaround', why: 'fixture', retireWhen: 'fixture' }
const overlay = (name, fields) => ({ ...base, id: `runtime.${name}`, ...fields })

function stageWith(t, files) {
  const stage = mkdtempSync(resolve(tmpdir(), 'overlay-engine-'))
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(resolve(stage, path, '..'), { recursive: true })
    writeFileSync(resolve(stage, path), content)
  }
  return stage
}

const append = text => ({ file }) => ({ file: replaceOnce(file, 'anchor', `anchor${text}`, 'fixture') })

test('overlays on the same file chain in registry order and are written once all succeed', async t => {
  const stage = stageWith(t, { 'a.ts': 'anchor' })
  await runOverlays('prepare', { stage, overlays: [
    overlay('first', { files: { file: 'a.ts' }, apply: append(' first') }),
    overlay('second', { files: { file: 'a.ts' }, apply: ({ file }) => ({ file: `${file} second` }) }),
  ] })
  assert.equal(readFileSync(resolve(stage, 'a.ts'), 'utf8'), 'anchor first second')
})

test('a failed anchor names the overlay and target, and nothing in the phase is written', async t => {
  const stage = stageWith(t, { 'a.ts': 'anchor', 'b.ts': 'changed upstream' })
  await assert.rejects(runOverlays('prepare', { stage, overlays: [
    overlay('ok', { files: { file: 'a.ts' }, apply: append(' patched') }),
    overlay('broken', { files: { file: 'b.ts' }, apply: append(' patched') }),
  ] }), /^Error: \[runtime\.broken\] b\.ts: fixture：锚点应出现 1 次，实际 0 次/)
  assert.equal(readFileSync(resolve(stage, 'a.ts'), 'utf8'), 'anchor')
})

test('audit mode classifies changed, unchanged, failed and skipped overlays without stopping', async t => {
  const stage = stageWith(t, { 'a.ts': 'anchor', 'b.ts': 'anchor', 'c.ts': 'drift' })
  const results = await runOverlays('prepare', { stage, audit: true, overlays: [
    overlay('effective', { files: { file: 'a.ts' }, apply: append(' x') }),
    overlay('obsolete', { files: { file: 'b.ts' }, apply: input => input }),
    overlay('broken', { files: { file: 'c.ts' }, apply: append(' x') }),
    overlay('disabled', { when: () => false, files: { file: 'a.ts' }, apply: append(' never') }),
  ] })
  assert.deepEqual(results.map(result => [result.id, result.status]), [
    ['runtime.effective', 'changed'], ['runtime.obsolete', 'unchanged'], ['runtime.broken', 'failed'], ['runtime.disabled', 'skipped'],
  ])
  assert.match(results[2].error, /\[runtime\.broken\] c\.ts/)
  assert.equal(readFileSync(resolve(stage, 'a.ts'), 'utf8'), 'anchor x')
})

test('JSON targets round-trip as objects and staging paths cannot escape', async t => {
  const stage = stageWith(t, { 'package.json': '{"name":"x"}' })
  await runOverlays('prepare', { stage, overlays: [overlay('json', {
    files: { manifest: { path: 'package.json', json: true } },
    apply: ({ manifest }) => ({ manifest: { ...manifest, version: '1.0.0' } }),
  })] })
  assert.equal(readFileSync(resolve(stage, 'package.json'), 'utf8'), '{\n  "name": "x",\n  "version": "1.0.0"\n}\n')
  await assert.rejects(runOverlays('prepare', { stage, overlays: [overlay('escape', {
    files: { file: '../outside.ts' }, apply: input => input,
  })] }), /staging 相对路径不合法/)
})

test('registry validation rejects ambiguous or undocumented entries', () => {
  assert.throws(() => validateOverlays([overlay('x', { files: { file: 'a' }, apply: x => x, copy: [] })]), /只能有一个/)
  assert.throws(() => validateOverlays([overlay('x', { files: { file: 'a' }, apply: x => x, why: '' })]), /缺少 why/)
  assert.throws(() => validateOverlays([overlay('x', { id: 'market.x', files: { file: 'a' }, apply: x => x })]), /runtime\./)
  assert.throws(() => replaceOnce('a a', 'a', 'b', 'label'), AnchorError)
})
