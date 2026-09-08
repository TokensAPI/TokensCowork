import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { preserveNativeDialogPosition } from './market-dialog-position-overlay.mjs'

const root = new URL('../../../', import.meta.url)
test('removes only the theme positioning override, retaining native market and Modal CSS', () => {
  const css = readFileSync(new URL('plugins/dsh-tokensapi-ui/src/client/theme/chrome.css', root), 'utf8').replaceAll('\r\n', '\n')
  const fixed = JSON.parse(preserveNativeDialogPosition(JSON.stringify(css)))
  assert.equal(fixed, css.replace('html[data-theme="clean"] [role="dialog"] {\n  position: relative;\n', 'html[data-theme="clean"] [role="dialog"] {\n'))
  const market = readFileSync(new URL('desktop/dsh-community-market/src/client/styles.ts', root), 'utf8')
  assert.match(market, /\.dshMarketOverlay\s*\{\s*position: fixed;/)
  assert.throws(() => preserveNativeDialogPosition(JSON.stringify(fixed)), /theme rule changed/)
})
test('the actual pinned production artifact contains the conflicting rule', () => {
  const bundle = readFileSync(new URL('.build/product-plugin-artifacts/dsh-tokensapi-ui/package/lib/client.js', root), 'utf8')
  assert.notEqual(preserveNativeDialogPosition(bundle), bundle)
  const entry = readFileSync(new URL('build/steps/staging-prepare.mjs', root), 'utf8')
  assert.match(entry, /preserveNativeDialogPosition\(readFileSync/)
  assert.doesNotMatch(entry, /portalMarketOverlay/)
})
