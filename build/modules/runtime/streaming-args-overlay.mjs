// Temporary DSH adaptation: stop re-parsing streamed tool-call arguments after every chunk.
//
// pi-ai 1.3.0 runs `block.arguments = parseStreamingJson(<all arguments so far>)` after each
// streamed argument delta. Every call re-parses the whole accumulated text (and on a parse error
// retries twice with partial / repaired parsers), so one tool call costs O(n^2) and blocks the
// host process: measured with the shipped function and 12-character deltas, 100 KB of arguments
// spend about 13 s and 300 KB about 124 s re-parsing.
//
// Upstream DeepSeek drops exactly these lines from pi-ai 1.1.0
// (desktop/deepseek-harness/patches/@earendil-works__pi-ai@1.1.0.patch, six files, "Runtime
// providers need the streamed argument parsing fix"); the pinned Desktop has no such patch for
// 1.2.0 / 1.3.0. This overlay applies the same deletion to 1.3.0, leaving a comment in its place.
//
// Why that is safe on 1.3.0: each provider still finalizes a tool call with
// `Object.assign(block, parseToolCallArguments(<complete text>))` at the end of the block
// (pi-messages copies the finished call from `toolcall_end`), and the DSH adapter
// (@deepseek-ai/dsh-llm-pi-ai 0.2.1-rc.2 toStreamChunks) only forwards the raw `event.delta`
// during streaming and `JSON.stringify(event.toolCall.arguments)` at `toolcall_end`; it never
// reads `block.arguments` mid-stream. The only observable difference is the `partial` message of
// a stream that fails mid-call: its unfinished call now carries `{}` instead of a best-effort
// prefix, and DSH maps an `error` event to usage + finish without reading content.
// openai-responses-shared still parses once at `response.function_call_arguments.done`, as the
// upstream patch leaves it; that is one parse per call, not per chunk.
import { AnchorError, countOf } from '../../pipeline/anchors.mjs'

const marker = '// TokensCowork: tool-call arguments are parsed once when the call ends (T0111)'

/** Each edited file: the line kept before the removed parse, and the removed parse itself. */
export const STREAMING_ARGUMENT_EDITS = {
  'anthropic-messages': {
    before: '                            block.partialJson += event.delta.partial_json;\n',
    parse: '                            block.arguments = parseStreamingJson(block.partialJson);\n',
  },
  'bedrock-converse-stream': {
    before: '        block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");\n',
    parse: '        block.arguments = parseStreamingJson(block.partialJson);\n',
  },
  'mistral-conversations': {
    before: '            block.partialArgs = (block.partialArgs || "") + argsDelta;\n',
    parse: '            block.arguments = parseStreamingJson(block.partialArgs);\n',
  },
  'openai-completions': {
    before: '                                block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;\n',
    parse: '                                block.arguments = parseStreamingJson(block.partialArgs);\n',
  },
  'openai-responses-shared': {
    before: '            slot.block.partialJson += event.delta;\n',
    parse: '            slot.block.arguments = parseStreamingJson(slot.block.partialJson);\n',
  },
  'pi-messages': {
    before: '                toolJson.set(event.contentIndex, json);\n',
    parse: '                partial.content[event.contentIndex].arguments =\n                    parseStreamingJson(json);\n',
  },
}

/** pi-ai files this overlay edits, relative to the package root. */
export const STREAMING_ARGUMENT_FILES = Object.keys(STREAMING_ARGUMENT_EDITS).map(name => `dist/api/${name}.js`)

const commentFor = parse => `${parse.match(/^ */)[0]}${marker}\n`

/**
 * @param name - key of STREAMING_ARGUMENT_EDITS (the file's base name).
 * @param source - that pi-ai `dist/api/<name>.js`.
 * @returns the file without the per-chunk parse; repeatable, CRLF input is normalized.
 */
export function skipStreamingArgumentParse(name, source) {
  const edit = STREAMING_ARGUMENT_EDITS[name]
  if (edit === undefined) throw new Error(`Unknown pi-ai streaming file: ${name}`)
  const normalized = source.replaceAll('\r\n', '\n')
  const upstream = edit.before + edit.parse
  const product = edit.before + commentFor(edit.parse)
  if (normalized.includes(marker)) {
    if (countOf(normalized, product) !== 1 || normalized.includes(upstream)) {
      throw new Error(`Incomplete product streaming-argument adaptation in ${name}; review the staging dependency`)
    }
    return source
  }
  const count = countOf(normalized, upstream)
  if (count !== 1) throw new AnchorError(`pi-ai ${name} per-chunk argument parse: 锚点应出现 1 次，实际 ${count} 次`)
  return normalized.replace(upstream, () => product)
}
