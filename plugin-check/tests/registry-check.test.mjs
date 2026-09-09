import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPublishedManifest, versionSatisfies } from '../lib/registry-check.mjs'

test('迷你 semver:或/且/插入符/波浪号/预发布', () => {
  assert.equal(versionSatisfies('0.1.3-alpha.1', '0.1.0-rc.8 || 0.1.3-alpha.1'), true)
  assert.equal(versionSatisfies('0.1.3-alpha.1', '>=0.1.0-rc.8 <0.2.0'), true)
  assert.equal(versionSatisfies('0.1.3-alpha.1', '>=0.1.0 <0.1.2'), false)
  assert.equal(versionSatisfies('4.0.2', '^4.0.1'), true)
  assert.equal(versionSatisfies('5.0.0', '^4.0.1'), false)
  assert.equal(versionSatisfies('1.2.9', '~1.2.3'), true)
  assert.equal(versionSatisfies('1.3.0', '~1.2.3'), false)
  assert.equal(versionSatisfies('1.0.0', 'not-a-range'), null)
})

const BASE = {
  name: '@fixture/plugin',
  version: '1.0.0',
  license: 'MIT',
  engines: { node: '>=22' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8 || 0.1.3-alpha.1' },
  dsh: { engine: '>=0.1.0-rc.8 <0.2.0', bundle: { patch: './cordis.patch.yml' } },
}
const rules = (findings, level) => findings.filter(f => f.level === level).map(f => f.rule)

test('合格清单零 error', () => {
  const findings = checkPublishedManifest(BASE, '0.1.3-alpha.1')
  assert.deepEqual(rules(findings, 'error'), [])
})

test('生命周期脚本/双内核/缺 bundle 逐条 error', () => {
  const findings = checkPublishedManifest({
    ...BASE,
    scripts: { postinstall: 'evil' },
    dependencies: { '@deepseek-ai/dsh-llm': '0.1.0' },
    dsh: { engine: BASE.dsh.engine },
  }, '0.1.3-alpha.1')
  assert.deepEqual(rules(findings, 'error').sort(), ['M2-lifecycle', 'M3-core-peer', 'M4-bundle'])
})

test('engine 不覆盖运行时是 error,peer 不含是 warning', () => {
  const findings = checkPublishedManifest({
    ...BASE,
    dsh: { ...BASE.dsh, engine: '>=0.1.0 <0.1.2' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  }, '0.1.3-alpha.1')
  assert.ok(rules(findings, 'error').includes('M6-engine'))
  assert.ok(rules(findings, 'warning').includes('M7-peer-range'))
})

test('本插件自己的清单必须零 error(自证)', async () => {
  const manifest = JSON.parse(
    (await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const findings = checkPublishedManifest(manifest, '0.1.3-alpha.1')
  assert.deepEqual(rules(findings, 'error'), [])
})
