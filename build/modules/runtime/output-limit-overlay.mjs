// Temporary DSH adaptation: keep the configured output limit when pi-ai has no reported usage.
//
// pi-ai lowers each request's max_tokens to `contextWindow - estimate - 4096`. Its estimate is
// meant to be "last reported usage + trailing messages", but DSH hands it history whose usage is
// always empty, so every request falls back to chars/3.5 over the whole conversation, including
// all earlier reasoning. That reasoning is replayed as a `reasoning` field, which TokensAPI does
// not count as prompt tokens (measured: 37 tokens with or without 8,000 tokens of it). In a long
// session with a reasoning model the estimate passes the window while real usage is far below
// it, max_tokens drops to a few hundred and then to 1, and every "continue" ends on the output
// limit again.
//
// Why sending the configured limit is safe today: compaction fires at
// min(window * 0.8, window - reserved - headroom), headroom 65,536 by default, where `reserved`
// is the route's declared maxTokens or 0 when none is declared. Either way the prompt stays at
// least 65,536 below the window, which covers the 32,768 this product sends. If a single step
// still overshoots, TokensAPI answers "maximum context length is N tokens", which pi-ai's
// isContextOverflow recognises and DSH recovers from by compacting.
// REVISIT when the effective output limit can exceed the compaction headroom without being
// declared on the route (DSH 0.2.2 raises the undeclared default to 128K): every request past
// the compaction threshold would then rely on that overflow recovery.
// The better fix is in DSH: pass real usage to pi-ai. The adapter only receives
// { role, content, source, id }; usage lives on the session event, so that needs agent-loop too.
import { replaceOnce } from '../../pipeline/anchors.mjs'

const marker = '// TokensCowork: no reported usage keeps the configured output limit v1'
const upstream = '    const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;'
const product = [
  `    ${marker}`,
  '    const estimate = estimateContextTokens(context);',
  '    if (estimate.lastUsageIndex === null)',
  '        return Math.max(MIN_MAX_TOKENS, maxTokens);',
  '    const available = model.contextWindow - estimate.tokens - CONTEXT_SAFETY_TOKENS;',
].join('\n')

/**
 * @param source - pi-ai `dist/api/simple-options.js`.
 * @returns the file with the estimate-only clamp disabled; repeatable.
 */
export function keepConfiguredOutputLimit(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  if (normalized.includes(marker)) {
    if (!normalized.includes(product) || normalized.includes(upstream)) {
      throw new Error('Incomplete product output-limit adaptation; review the staging dependency')
    }
    return source
  }
  return replaceOnce(normalized, upstream, product, 'pi-ai clampMaxTokensToContext')
}
