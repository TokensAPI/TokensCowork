import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { buildPlan, HOST_ROOT, parseOptions, summarize } from './plugin-host-contracts.mjs'

const root = resolve(import.meta.dirname, '../..')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const config = JSON.parse(readFileSync(resolve(root, 'build', 'pipeline', 'plugin-host-contracts.json'), 'utf8'))

test('the plan covers every enabled built-in plugin at its pin plus the configured market plugins', () => {
  const plan = buildPlan({ product, config })
  const builtins = product.plugins.filter(plugin => plugin.enabledByDefault)
  assert.deepEqual(plan.filter(item => item.kind === 'builtin').map(item => item.id), builtins.map(plugin => plugin.id))
  for (const item of plan.filter(item => item.kind === 'builtin')) assert.match(item.commit, /^[a-f0-9]{40}$/)
  assert.deepEqual(plan.filter(item => item.kind === 'market').map(item => item.id), config.market.map(entry => entry.id))
  assert.ok(HOST_ROOT.endsWith('dsh-plugin-desktop'))
})

test('exemptions name only built-in plugins that really have no check:host script', () => {
  for (const [id, reason] of Object.entries(config.exempt)) {
    const plugin = product.plugins.find(item => item.id === id)
    assert.ok(plugin, `${id} is not a product plugin`)
    assert.ok(reason.length > 10, `${id} needs a reason`)
    const manifest = JSON.parse(readFileSync(resolve(root, plugin.path, 'package.json'), 'utf8'))
    assert.equal(manifest.scripts?.['check:host'], undefined, `${id} has check:host and must not be exempt`)
  }
  // Every other built-in plugin must ship the contract command — that is the T0047 rule.
  for (const plugin of product.plugins.filter(item => item.enabledByDefault && !(item.id in config.exempt))) {
    const manifest = JSON.parse(readFileSync(resolve(root, plugin.path, 'package.json'), 'utf8'))
    assert.ok(manifest.scripts?.['check:host'], `${plugin.id} lacks check:host`)
  }
})

test('--only narrows the plan and --plan is accepted', () => {
  assert.deepEqual(parseOptions(['--plan']), { plan: true, only: undefined })
  const only = parseOptions(['--only', 'tokens-login, tokens-connect']).only
  assert.deepEqual([...only], ['tokens-login', 'tokens-connect'])
  assert.deepEqual(buildPlan({ product, config, only }).map(item => item.id), ['tokens-login', 'tokens-connect'])
  assert.throws(() => parseOptions(['--bogus']), /Usage/)
})

test('summaries count executed, failed and not-executed lines', () => {
  assert.deepEqual(summarize('LOGIN-HOST-01 PASS\nLOGIN-HOST-02 FAIL\nHOST-07 NOT EXECUTED on DSH 0.1.5-rc.2\n'), { pass: 1, fail: 1, notExecuted: 1 })
})
