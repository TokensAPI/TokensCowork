import assert from 'node:assert/strict'
import { test } from 'node:test'

test('market staging entry imports its real overlay dependency graph', async () => {
  const entry = await import('./market-staging-overlay.mjs')
  assert.equal(typeof entry.applyMarketSourceOverlays, 'function')
})
