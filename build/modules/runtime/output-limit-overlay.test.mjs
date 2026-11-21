import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { keepConfiguredOutputLimit } from './output-limit-overlay.mjs'

// pi-ai 1.3.0 dist/api/simple-options.js, the function this overlay edits. pi-ai is an npm
// dependency with no source in this repository, so the pinned text is kept here; the last test
// checks the installed file whenever a staging install exists.
const upstream = `import { clampThinkingLevel } from "../models.js";
import { estimateContextTokens } from "../utils/estimate.js";
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
export function clampMaxTokensToContext(model, context, maxTokens) {
    if (model.contextWindow <= 0)
        return Math.max(MIN_MAX_TOKENS, maxTokens);
    const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
    return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}
`

/** Load clampMaxTokensToContext from a simple-options source with a given estimate. */
function clampOf(source, estimate) {
  const body = source.split('\n').filter(line => !line.startsWith('import ')).join('\n').replace('export function', 'function')
  return new Function('estimateContextTokens', `${body}\nreturn clampMaxTokensToContext`)(() => estimate)
}
const model = { contextWindow: 262144 }
const estimateOnly = tokens => ({ tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null })
const withUsage = tokens => ({ tokens, usageTokens: tokens - 10, trailingTokens: 10, lastUsageIndex: 3 })

test('upstream clamps an estimate-only history to 907 and then 1 output token (session 14d7fdc4)', () => {
  // Real usage was 181,942 of 262,144; the chars/3.5 estimate, counting unsent reasoning, was 257,141.
  assert.equal(clampOf(upstream, estimateOnly(257141))(model, {}, 32768), 907)
  assert.equal(clampOf(upstream, estimateOnly(258116))(model, {}, 32768), 1)
})

test('with no reported usage the configured output limit is sent', () => {
  const patched = keepConfiguredOutputLimit(upstream)
  assert.equal(clampOf(patched, estimateOnly(257141))(model, {}, 32768), 32768)
  assert.equal(clampOf(patched, estimateOnly(258116))(model, {}, 32768), 32768)
  assert.equal(clampOf(patched, estimateOnly(999999))(model, {}, 32768), 32768)
  assert.equal(clampOf(patched, estimateOnly(10))(model, {}, 32768), 32768)
})

test('a history that reports usage is still clamped as upstream does', () => {
  const patched = keepConfiguredOutputLimit(upstream)
  for (const tokens of [1000, 230000, 257141, 258116, 300000]) {
    assert.equal(clampOf(patched, withUsage(tokens))(model, {}, 32768), clampOf(upstream, withUsage(tokens))(model, {}, 32768))
  }
  assert.equal(clampOf(patched, withUsage(257141))(model, {}, 32768), 907)
  // A model without a window is left alone, as upstream.
  assert.equal(clampOf(patched, estimateOnly(5))({ contextWindow: 0 }, {}, 0), 1)
})

test('the overlay is repeatable, keeps CRLF input working and fails closed on drift', () => {
  const patched = keepConfiguredOutputLimit(upstream)
  assert.equal(keepConfiguredOutputLimit(patched), patched)
  assert.equal(keepConfiguredOutputLimit(upstream.replaceAll('\n', '\r\n')), patched)
  assert.throws(() => keepConfiguredOutputLimit(upstream.replace('CONTEXT_SAFETY_TOKENS;', 'SAFETY;')), AnchorError)
  assert.throws(() => keepConfiguredOutputLimit(patched.replace('if (estimate.lastUsageIndex === null)', 'if (false)')), /Incomplete product output-limit adaptation/)
})

test('the installed pi-ai still has the function this overlay edits', t => {
  const installed = resolve(import.meta.dirname, '../../../.build/desktop/dsh-plugin-desktop/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js')
  if (!existsSync(installed)) return t.skip('no staging install')
  const source = readFileSync(installed, 'utf8')
  const patched = keepConfiguredOutputLimit(source)
  assert.equal(clampOf(patched.slice(0, patched.indexOf('export function resolveSamplingParams')), estimateOnly(258116))(model, {}, 32768), 32768)
})
