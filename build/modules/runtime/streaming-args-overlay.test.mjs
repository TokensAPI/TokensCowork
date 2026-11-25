import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { STREAMING_ARGUMENT_EDITS, STREAMING_ARGUMENT_FILES, skipStreamingArgumentParse } from './streaming-args-overlay.mjs'

// pi-ai 1.3.0 is an npm dependency with no source in this repository. The always-on tests use
// the pinned lines from STREAMING_ARGUMENT_EDITS; the stream tests below run the installed
// package (pristine and patched side by side) whenever a staging install exists.
const pinned = name => {
  const { before, parse } = STREAMING_ARGUMENT_EDITS[name]
  return `function handler() {\n${before}${parse}        stream.push(next);\n}\nlater(parseToolCallArguments(text));\n`
}

test('every edited file loses exactly its per-chunk parse and keeps the rest', () => {
  assert.deepEqual(STREAMING_ARGUMENT_FILES.map(file => file.slice('dist/api/'.length, -3)).sort(), [
    'anthropic-messages', 'bedrock-converse-stream', 'mistral-conversations', 'openai-completions',
    'openai-responses-shared', 'pi-messages'])
  for (const name of Object.keys(STREAMING_ARGUMENT_EDITS)) {
    const source = pinned(name)
    const patched = skipStreamingArgumentParse(name, source)
    assert.doesNotMatch(patched, /parseStreamingJson/, name)
    assert.equal(patched.replace(/^ *\/\/ TokensCowork: .*\n/m, ''), source.replace(STREAMING_ARGUMENT_EDITS[name].parse, ''), name)
  }
})

test('the overlay is repeatable, keeps CRLF input working and fails closed on drift', () => {
  for (const name of Object.keys(STREAMING_ARGUMENT_EDITS)) {
    const source = pinned(name)
    const patched = skipStreamingArgumentParse(name, source)
    assert.equal(skipStreamingArgumentParse(name, patched), patched)
    assert.equal(skipStreamingArgumentParse(name, source.replaceAll('\n', '\r\n')), patched)
    assert.throws(() => skipStreamingArgumentParse(name, source.replace('parseStreamingJson', 'parsePartial')), AnchorError)
    assert.throws(() => skipStreamingArgumentParse(name, source + source), AnchorError)
    assert.throws(() => skipStreamingArgumentParse(name, patched + source), /Incomplete product streaming-argument adaptation/)
  }
  assert.throws(() => skipStreamingArgumentParse('google', ''), /Unknown pi-ai streaming file/)
})

/* ------------- real pi-ai 1.3.0: pristine and patched graphs side by side ------------- */
const pkg = resolve(import.meta.dirname, '../../../.build/desktop/dsh-plugin-desktop/node_modules/@earendil-works/pi-ai')
const installed = existsSync(resolve(pkg, 'package.json'))
  && JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8')).version === '1.3.0'
// Real path: ESM resolves relative imports from the real location of a linked staging.
const pkgUrl = installed ? pathToFileURL(realpathSync(pkg)).href + '/' : ''
const tagOf = url => url.match(/\?t0111=(\w+)$/)?.[1]
if (installed) {
  // Both graphs count parseStreamingJson calls; only the "patched" graph gets the overlay.
  registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context)
      const tag = context.parentURL === undefined ? undefined : tagOf(context.parentURL)
      return tag !== undefined && result.url.startsWith(pkgUrl) && tagOf(result.url) === undefined
        ? { ...result, url: `${result.url}?t0111=${tag}` } : result
    },
    load(url, context, next) {
      const result = next(url, context)
      const tag = tagOf(url)
      if (tag === undefined) return result
      let source = String(result.source)
      const file = url.slice(pkgUrl.length, url.indexOf('?'))
      if (file === 'dist/utils/json-parse.js') {
        source = source.replace('export function parseStreamingJson(partialJson) {',
          `$&\n    globalThis.t0111Parses.${tag}++;`)
      }
      const name = file.slice('dist/api/'.length, -3)
      if (STREAMING_ARGUMENT_FILES.includes(file)) {
        // A staging that already ran the overlay is turned back into the 1.3.0 text for "pristine".
        source = skipStreamingArgumentParse(name, source)
        if (tag === 'pristine') source = source.replace(/^ *\/\/ TokensCowork: tool-call arguments .*\n/m, () => STREAMING_ARGUMENT_EDITS[name].parse)
      }
      return { ...result, source }
    },
  })
}
globalThis.t0111Parses = { pristine: 0, patched: 0 }
const providerOf = async (tag, file) => (await import(`${pkgUrl}dist/api/${file}.js?t0111=${tag}`)).stream

// 16 KB with quotes, backslashes, CJK and astral characters; 12-character deltas split escapes
// and surrogate pairs.
const ARGS = { file_path: 'C:\\x\\report.md', content: ('x'.repeat(40) + ' "q" \\ \n\t 中文 ✓ 😀 ').repeat(260).slice(0, 16 * 1024) }
const FULL = JSON.stringify(ARGS)
const pieces = text => Array.from({ length: Math.ceil(text.length / 12) }, (_, i) => text.slice(i * 12, i * 12 + 12))
const sse = events => events.map(([event, data]) => `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('')
const tools = [{ name: 'write', description: 'write a file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } } }]
const context = { messages: [{ role: 'user', content: 'write it', timestamp: 1 }], tools }
const modelOf = api => ({ id: 'stub', name: 'stub', api, provider: 'stub', baseUrl: 'http://127.0.0.1:9/v1', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 32768 })

const chunk = delta => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta }] })
const completions = (args, finish) => sse([
  [undefined, chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '' } }] })],
  ...pieces(args).map(piece => [undefined, chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] })]),
  ...finish === undefined ? [] : [[undefined, { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: finish }] }], [undefined, '[DONE]']],
])
const anthropic = args => sse([
  ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'stub', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write', input: {} } }],
  ...pieces(args).map(piece => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: piece } }]),
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }],
])
const item = args => ({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write', arguments: args, status: 'completed' })
const responses = args => sse([
  ['response.created', { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [] } }],
  ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item(''), status: 'in_progress' } }],
  ...pieces(args).map(piece => ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: piece }]),
  ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: args }],
  ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: item(args) }],
  ['response.completed', { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [item(args)],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }],
])

/** Run one stub stream through a graph; returns the finished calls, the terminal event and the parse count. */
async function run(tag, file, api, body) {
  const stream = await providerOf(tag, file)
  // A function body is a connection that drops after sending that text.
  const payload = typeof body === 'function'
    ? new ReadableStream({ sent: false, pull(controller) {
      if (this.sent) controller.error(new Error('socket hang up'))
      else { this.sent = true; controller.enqueue(new TextEncoder().encode(body())) }
    } }, { highWaterMark: 0 })
    : body
  const fetch = async () => new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  globalThis.t0111Parses[tag] = 0
  const calls = []
  let terminal
  let deltas = ''
  for await (const event of stream(modelOf(api), context, { apiKey: 'local-stub', fetch })) {
    if (event.type === 'toolcall_delta') deltas += event.delta
    if (event.type === 'toolcall_end') calls.push(structuredClone(event.toolCall))
    if (event.type === 'done' || event.type === 'error') terminal = structuredClone(event)
  }
  return { calls, terminal, deltas, parses: globalThis.t0111Parses[tag] }
}

const providers = [
  ['openai-completions', 'openai-completions', () => completions(FULL, 'tool_calls'), 0],
  ['anthropic-messages', 'anthropic-messages', () => anthropic(FULL), 0],
  // response.function_call_arguments.done still parses once, as in the upstream patch.
  ['openai-responses', 'openai-responses', () => responses(FULL), 1],
]
for (const [file, api, body, patchedParses] of providers) {
  test(`${api}: the finished tool call is unchanged and no longer re-parsed per chunk`, { skip: !installed && 'no pi-ai 1.3.0 staging install' }, async () => {
    const before = await run('pristine', file, api, body())
    const after = await run('patched', file, api, body())
    assert.equal(before.calls.length, 1)
    assert.deepEqual(before.calls[0].arguments, ARGS)
    assert.deepEqual(after.calls, before.calls)
    assert.equal(after.deltas, FULL)
    assert.equal(after.deltas, before.deltas)
    assert.equal(after.terminal.type, 'done')
    assert.deepEqual(after.terminal.message.content, before.terminal.message.content)
    assert.ok(before.parses >= pieces(FULL).length, `pristine parses ${before.parses}`)
    assert.equal(after.parses, patchedParses)
  })
}

test('openai-completions: arguments cut off by the output limit end the same way', { skip: !installed && 'no pi-ai 1.3.0 staging install' }, async () => {
  const cut = FULL.slice(0, Math.floor(FULL.length / 2))
  const before = await run('pristine', 'openai-completions', 'openai-completions', completions(cut, 'length'))
  const after = await run('patched', 'openai-completions', 'openai-completions', completions(cut, 'length'))
  assert.equal(before.terminal.reason, 'length')
  assert.deepEqual(before.calls[0].arguments, {})
  assert.match(before.calls[0].argumentsError, /Received arguments:/)
  assert.deepEqual(after.calls, before.calls)
  assert.deepEqual(after.terminal.message.content, before.terminal.message.content)
  assert.equal(after.parses, 0)
})

test('openai-completions: a stream that ends without finish_reason finalizes the cut call the same way', { skip: !installed && 'no pi-ai 1.3.0 staging install' }, async () => {
  const cut = FULL.slice(0, Math.floor(FULL.length / 2))
  const before = await run('pristine', 'openai-completions', 'openai-completions', completions(cut))
  const after = await run('patched', 'openai-completions', 'openai-completions', completions(cut))
  assert.equal(before.terminal.type, 'error')
  assert.equal(after.terminal.error.errorMessage, before.terminal.error.errorMessage)
  assert.deepEqual(after.calls, before.calls)
  assert.deepEqual(after.terminal.error.content, before.terminal.error.content)
  assert.equal(after.parses, 0)
})

test('openai-completions: a connection that drops mid-call errors the same way; only the unfinished partial differs', { skip: !installed && 'no pi-ai 1.3.0 staging install' }, async () => {
  const cut = FULL.slice(0, Math.floor(FULL.length / 2))
  const before = await run('pristine', 'openai-completions', 'openai-completions', () => completions(cut))
  const after = await run('patched', 'openai-completions', 'openai-completions', () => completions(cut))
  assert.equal(before.terminal.type, 'error')
  assert.equal(after.terminal.type, 'error')
  assert.equal(after.terminal.error.errorMessage, before.terminal.error.errorMessage)
  assert.deepEqual([before.calls, after.calls], [[], []])
  // DSH's adapter turns an error event into usage + finish and never reads this content.
  assert.equal(before.terminal.error.content[0].arguments.file_path, ARGS.file_path)
  assert.deepEqual(after.terminal.error.content[0].arguments, {})
})

test('the installed pi-ai still has every line this overlay edits', { skip: !existsSync(pkg) && 'no staging install' }, () => {
  for (const file of STREAMING_ARGUMENT_FILES) {
    const patched = skipStreamingArgumentParse(file.slice('dist/api/'.length, -3), readFileSync(resolve(pkg, file), 'utf8'))
    assert.match(patched, /TokensCowork: tool-call arguments are parsed once/)
  }
})
