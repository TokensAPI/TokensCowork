import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const config = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8')
// Parse only the deliberately simple package ACL block, fail on missing rules.
const rules = new Map([...config.matchAll(/^  '([^']+)':\r?\n((?:    [^\n]*\r?\n)+)/gm)].map(([, name, body]) =>
  [name, Object.fromEntries([...body.matchAll(/^    (\w+): (.+?)\r?$/gm)].map(([, k, v]) => [k, v]))]))
test('all owned packages deny anonymous and ordinary accounts; Market cannot write', () => {
  for (const name of ['@tokensapi/*', '@tokens/*', '@tokensapi-private/*', 'dsh-tokensapi-ui', 'tokens-dsh-web-search']) {
    const rule = rules.get(name)
    assert.ok(rule, name)
    assert.equal(rule.access, 'tokenscowork market', name)
    assert.equal(rule.publish, 'tokenscowork', name)
    assert.equal(rule.unpublish, 'tokenscowork', name)
  }
})
test('third-party uplink remains public and private namespace never goes to npm', () => {
  assert.equal(rules.get('**').access, '$all')
  assert.equal(rules.get('**').proxy, 'npmjs')
  assert.equal(rules.get('**').publish, 'tokenscowork')
  assert.equal(rules.get('@tokensapi-private/*').proxy, undefined)
  assert.match(config, /max_users: -1/)
})
