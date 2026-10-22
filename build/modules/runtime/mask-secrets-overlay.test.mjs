import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { alignDiagnosticsSpec, keepShortErrorCodes } from './mask-secrets-overlay.mjs'

// Exercise the actual pinned upstream sources, not copied fixtures.
const root = resolve(import.meta.dirname, '../../..')
const source = readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/src/mask-secrets.ts'), 'utf8')
const spec = readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/tests/diagnostics.spec.ts'), 'utf8')

async function loadMasker(text) {
  const dir = mkdtempSync(join(tmpdir(), 'mask-secrets-overlay-'))
  const file = join(dir, 'mask-secrets.mjs')
  writeFileSync(file, stripTypeScriptTypes(text))
  return (await import(pathToFileURL(file).href)).maskSecrets
}

test('upstream masks every code value; the overlay keeps short error codes and still masks long ones', async () => {
  const upstream = await loadMasker(source)
  assert.equal(upstream('{"code":"internal"}'), '{"code":"****"}')

  const patched = keepShortErrorCodes(source)
  assert.equal(keepShortErrorCodes(patched), patched, '幂等')
  const masked = await loadMasker(patched)
  assert.equal(masked('{"name":"HarnessRpcError","method":"workspace.list","code":"internal","details":{}}'),
    '{"name":"HarnessRpcError","method":"workspace.list","code":"internal","details":{}}')
  assert.equal(masked('polling stopped: {"code":"ECONNRESET","deliveryOutcome":"unknown"}'),
    'polling stopped: {"code":"ECONNRESET","deliveryOutcome":"unknown"}')
  assert.equal(masked('{"code":"4/0AX4XfWhLongEnoughToBeAnOAuthCode"}'), '{"code":"****"}')
  assert.equal(masked('{"authorization_code":"short"}'), '{"authorization_code":"****"}')
  assert.equal(masked('{"auth_code":"short"}'), '{"auth_code":"****"}')
  assert.equal(masked('code=4/0AX4XfWhLongEnoughToBeAnOAuthCode'), 'code=****')
  assert.equal(masked('code: session-not-found'), 'code: session-not-found')
  assert.equal(masked('{"code":"gateway/invocation-unavailable"}'), '{"code":"gateway/invocation-unavailable"}')
  assert.equal(masked('{"code":"HTTP_429_RATE_LIMITED"}'), '{"code":"HTTP_429_RATE_LIMITED"}')
  // Everything else the upstream masker did still holds.
  assert.equal(masked('{"api_key":"short-secret","token":"abc123"}'), '{"api_key":"****","token":"****"}')
  assert.equal(masked('GET https://example.com/cb?code=abc&mode=fast'), 'GET https://example.com/cb?code=****&mode=fast')
})

test('the upstream diagnostics spec follows the product rule', () => {
  const patched = alignDiagnosticsSpec(spec)
  assert.equal(alignDiagnosticsSpec(patched), patched, '幂等')
  assert.ok(patched.includes('"code":"short-code","authorization_code":"****"'))
  assert.ok(patched.includes(`expect(maskSecrets('HarnessRpcError code: internal')).toBe('HarnessRpcError code: internal')`))
  assert.ok(!patched.includes(`expect(masked).not.toContain('short-code')`))
})

test('anchors fail loudly when upstream changes', () => {
  assert.throws(() => keepShortErrorCodes('changed upstream'), /未找到唯一锚点/)
  assert.throws(() => alignDiagnosticsSpec('changed upstream'), /未找到唯一锚点/)
})
