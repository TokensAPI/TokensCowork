import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readCss } from '../../../plugins/dsh-tokensapi-ui/scripts/read-css.mjs'

const root = new URL('../../../', import.meta.url)
const obsoleteRule = 'html[data-theme="clean"] [role="dialog"] {\n  position: relative;\n'
test('the pinned theme preserves native dialog positioning without a build patch', () => {
  const css = readCss(fileURLToPath(new URL('plugins/dsh-tokensapi-ui/src/client/theme/chrome.css', root))).replaceAll('\r\n', '\n')
  const dialog = css.match(/html\[data-theme="clean"\] \[role="dialog"\]\s*\{([^}]+)\}/u)
  assert.ok(dialog, 'missing dialog theme rule')
  assert.doesNotMatch(dialog[1], /\bposition\s*:/u)
  const market = readFileSync(new URL('desktop/dsh-community-market/src/client/styles.ts', root), 'utf8')
  assert.match(market, /\.dshMarketOverlay\s*\{\s*position: fixed;/)
})
test('the published artifact needs no obsolete dialog-position rewrite during staging', () => {
  const bundle = readFileSync(new URL('.build/product-plugin-artifacts/dsh-tokensapi-ui/package/lib/client.js', root), 'utf8')
  assert.ok(bundle.includes(JSON.stringify('html[data-theme="clean"] [role="dialog"] {\n  backdrop-filter: none !important;').slice(1, -1)))
  assert.ok(!bundle.includes(JSON.stringify(obsoleteRule).slice(1, -1)))
  const entry = readFileSync(new URL('build/pipeline/staging-prepare.mjs', root), 'utf8')
  assert.doesNotMatch(entry, /preserveNativeDialogPosition|portalMarketOverlay/u)
})
