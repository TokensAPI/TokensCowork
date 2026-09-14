import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { disableUpstreamUpdates, verifyProductUpdateMenu, verifyDisabledUpdateMenu, configureProductUpdates } from './updates-overlay.mjs'

const read = path => readFileSync(new URL(`../../../desktop/dsh-plugin-desktop/${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
test('product and clean menu predicates accept only their intended tray entries', () => {
  const source = read('scripts/verify-profile-boot.mjs')
  const start = source.indexOf("  if (!trayItems.some(item => item.label() === 'Check for Updates…'))")
  assert.ok(start >= 0)
  const original = source.slice(start, source.indexOf('\n  }', start) + 4)
  const product = verifyProductUpdateMenu(original)
  const clean = verifyDisabledUpdateMenu(original)
  const run = (code, labels) => runInNewContext(code, { trayItems: labels.map(value => ({ label: () => value })) })
  run(product, ['Check Updates…'])
  run(clean, [])
  assert.throws(() => run(product, []))
  assert.throws(() => run(product, ['Check for Updates…', 'Check Updates…']))
  assert.throws(() => run(clean, ['Check Updates…']))
})
test('official updates stay disabled and product release configuration remains explicit', () => {
  assert.match(disableUpstreamUpdates(read('cordis.patch.yml')), /- id: desktop-updates\n  disabled: true/)
  const entry = "    - id: tokens-version-updates\r\n      name: '@tokens/dsh-version-updates'"
  assert.match(configureProductUpdates(entry, { name: 'TokensCowork' }, 'TokensAPI', 'TokensCowork'),
    /releaseAPIURL: https:\/\/api.github.com\/repos\/TokensAPI\/TokensCowork\/releases\/latest/)
  assert.throws(() => disableUpstreamUpdates('changed'))
  assert.throws(() => configureProductUpdates('changed', { name: 'TokensCowork' }, 'TokensAPI', 'TokensCowork'))
})
