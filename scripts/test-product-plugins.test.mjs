import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertCompleteTestOutput, installCommand, parseOptions, testScript } from './test-product-plugins.mjs'

test('exit zero with skipped or incomplete tests cannot satisfy the promotion gate', () => {
  assertCompleteTestOutput('72/72 cases passed; all passed.\n# skipped 0\n# todo 0')
  assertCompleteTestOutput('✔ rejects incomplete configuration\nℹ skipped 0\nℹ todo 0')
  for (const output of ['# skipped 1', 'ℹ skipped 1', 'Tests 12 passed | 2 skipped', 'INCOMPLETE CASE-001', '# todo 1']) {
    assert.throws(() => assertCompleteTestOutput(output))
  }
})

test('existing case runners take priority; missing scripts remain excluded', () => {
  assert.equal(testScript({ scripts: { test: 'vitest run', 'test:cases': 'node cases.mjs' } }), 'test:cases')
  assert.equal(testScript({ scripts: { test: 'node --test' } }), 'test')
  assert.equal(testScript({}), undefined)
})

test('tag arguments cannot turn into Git options or arbitrary shell commands', () => {
  assert.deepEqual(parseOptions(['--ref', 'v0.5.19', '--plan']), { ref: 'v0.5.19', plan: true })
  for (const args of [['--ref'], ['--ref', '--help'], ['--ref', 'v1;echo bad'], ['--unknown']]) {
    assert.throws(() => parseOptions(args))
  }
})

test('lockfiles select frozen dependency installation instead of rewriting source locks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-install-plan-'))
  try {
    writeFileSync(join(directory, 'pnpm-lock.yaml'), '')
    assert.deepEqual(installCommand(directory, { packageManager: 'pnpm@11.7.0' }), ['corepack', ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--ignore-scripts']])
    writeFileSync(join(directory, 'package-lock.json'), '{}')
    assert.equal(installCommand(directory, {})[1][0], 'ci')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('promotion runs the tag regression gate before applying Release changes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/promote-release.yml', import.meta.url), 'utf8')
  const regression = readFileSync(new URL('../.github/workflows/plugin-regression.yml', import.meta.url), 'utf8')
  assert.match(workflow, /uses: \.\/\.github\/workflows\/plugin-regression.yml/)
  assert.match(workflow, /needs: plugin-tests/)
  assert.match(workflow, /ref: \$\{\{ inputs.tag \}\}/)
  assert.match(regression, /workflow_dispatch:/)
  assert.match(regression, /submodules: recursive/)
  assert.match(regression, /node scripts\/test-product-plugins.mjs --ref "\$\{PRODUCT_REF\}"/)
  assert.doesNotMatch(regression, /continue-on-error/)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('- name: Validate and promote')), /if: always\(\)|continue-on-error/)
})
