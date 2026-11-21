// Temporary DSH adaptation: keep the configured output limit when pi-ai has no reported usage.
//
// pi-ai lowers each request's max_tokens to `contextWindow - estimate - 4096`. Its estimate is
// meant to be "last reported usage + trailing messages", but DSH hands it history whose usage is
// always empty, so every request falls back to chars/3.5 over the whole conversation, including
// all earlier reasoning that is never sent to the provider. In a long session with a reasoning
// model the estimate passes the window while real usage is far below it, max_tokens drops to a
// few hundred and then to 1, and every "continue" ends on the output limit again.
//
// DSH's own compaction already reserves the full configured output (threshold =
// min(window * ratio, window - maxTokens - headroom)), and DSH's native DeepSeek adapter sends
// the configured limit without estimating. So with no reported usage, send the configured limit.
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
