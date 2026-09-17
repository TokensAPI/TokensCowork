#!/usr/bin/env node
/* ====================================================================
 * Responses 协议循环复现对照测试
 *
 * 场景取自 session.jsonl(session-672b9faa):模型在排查 notion 插件时
 * 对 desktop-plugins.js 的同一 grep 命令连续重复 58 次。本脚本用
 * N 轮完全相同的 function_call/function_call_output 历史,分别经
 * Responses 与 Chat Completions 协议发往指定 endpoint,统计模型是否
 * 继续发出同一调用(循环)还是改变行为(跳出)。
 *
 * 用法:
 *   node scripts/test-responses-loop.mjs --url http://127.0.0.1:8081 --protocol responses
 *   node scripts/test-responses-loop.mjs --url https://tokensapi.ai --key sk-... --protocol completions
 *
 * 判定:
 *   REPEAT  —— 返回了解析出的 function_call/tool_call 且命令与历史完全一致
 *   BREAK   —— 返回了不同的工具调用或文本回答
 *   DSML    —— 工具调用以 DSML 原文泄漏在文本里(协议转换脆弱的表现)
 * ==================================================================== */

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) =>
  value.startsWith('--') ? [value.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true] : null,
).filter(Boolean))
const BASE_URL = (args.url ?? 'http://127.0.0.1:8081').replace(/\/$/, '')
const PROTOCOL = args.protocol ?? 'responses'
const REPEATS = Number(args.repeats ?? 8)
const ROUNDS = Number(args.rounds ?? 3)
const MODEL = args.model ?? 'deepseek-v4-flash'
const API_KEY = args.key ?? process.env.TOKENSAPI_KEY ?? 'none'
const TEMPERATURE = args.temperature === undefined ? undefined : Number(args.temperature)

// 会话中模型反复发出的命令(原样)
const LOOP_COMMAND = 'grep -n "plugin\\|Plugin\\|node_modules\\|require\\|import" /Applications/TokensHarness.app/Contents/Resources/app.asar.unpacked/lib/desktop-plugins.js 2>/dev/null | head -40'
const CALL_ARGUMENTS = JSON.stringify({ command: LOOP_COMMAND, description: 'Inspect desktop-plugins.js plugin loading logic' })
// 会话中该命令的真实输出(截取,保持结构)
const LOOP_OUTPUT = `1:import { assertDesktopProfileName } from "./profile-manager.js";
2:import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
3:import { dirname, isAbsolute, join } from "node:path";
4:import { PROFILE_TEMPLATES, resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
5:import { randomBytes } from "node:crypto";
6:import { chmod, lstat, mkdir } from "node:fs/promises";
7:import { Service } from "@deepseek-ai/cordis";
8:import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
9://#region src/desktop-plugins.ts
11:const BIN_NAME = "dsh-plugin-desktop";
29:	"dsh-plugin-desktop",
33:var DesktopPluginsError = class extends Error {
38:		this.name = "DesktopPluginsError";
44:		profiles: []
51:	assertDesktopProfileName(bootstrap.profileName);
56:	if (!directoryInfo.isDirectory()) throw new DesktopPluginsError(...)`

const BASH_TOOL = {
  name: 'bash',
  description: 'Execute a bash command (`bash -c`) and return its stdout/stderr.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute.' },
      description: { type: 'string', description: 'What the command does.' },
    },
    required: ['command'],
  },
}
const USER_PROMPT = '帮我链接一下notion'

function buildResponsesRequest() {
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: USER_PROMPT }] }]
  for (let index = 0; index < REPEATS; index += 1) {
    input.push({ type: 'function_call', id: `fc_g${index}`, call_id: `call_g${index}`, name: 'bash', arguments: CALL_ARGUMENTS })
    input.push({ type: 'function_call_output', call_id: `call_g${index}`, output: LOOP_OUTPUT })
  }
  return {
    model: MODEL,
    store: false,
    max_output_tokens: 2000,
    ...TEMPERATURE === undefined ? {} : { temperature: TEMPERATURE },
    input,
    tools: [{ type: 'function', ...BASH_TOOL }],
  }
}

function buildCompletionsRequest() {
  const messages = [{ role: 'user', content: USER_PROMPT }]
  for (let index = 0; index < REPEATS; index += 1) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_g${index}`, type: 'function', function: { name: 'bash', arguments: CALL_ARGUMENTS } }],
    })
    messages.push({ role: 'tool', tool_call_id: `call_g${index}`, content: LOOP_OUTPUT })
  }
  return {
    model: MODEL,
    max_tokens: 2000,
    ...TEMPERATURE === undefined ? {} : { temperature: TEMPERATURE },
    messages,
    tools: [{ type: 'function', function: BASH_TOOL }],
  }
}

function classifyResponses(payload) {
  const output = payload.output ?? []
  for (const item of output) {
    if (item.type === 'function_call') {
      const command = String(item.arguments ?? '')
      return command.includes('grep') && command.includes('desktop-plugins') ? 'REPEAT' : `BREAK(call:${command.slice(0, 60)})`
    }
  }
  for (const item of output) {
    if (item.type === 'message') {
      for (const content of item.content ?? []) {
        if (content.type === 'output_text') {
          if (content.text.includes('DSML')) return 'DSML'
          return `BREAK(text:${content.text.slice(0, 60).replaceAll('\n', ' ')})`
        }
      }
    }
  }
  return `EMPTY(${JSON.stringify(payload).slice(0, 120)})`
}

function classifyCompletions(payload) {
  for (const choice of payload.choices ?? []) {
    const message = choice.message ?? {}
    const calls = message.tool_calls ?? []
    if (calls.length > 0) {
      const command = String(calls[0].function?.arguments ?? '')
      return command.includes('grep') && command.includes('desktop-plugins') ? 'REPEAT' : `BREAK(call:${command.slice(0, 60)})`
    }
    if (message.content) return `BREAK(text:${String(message.content).slice(0, 60).replaceAll('\n', ' ')})`
  }
  return `EMPTY(${JSON.stringify(payload).slice(0, 120)})`
}

const endpoint = PROTOCOL === 'responses' ? `${BASE_URL}/v1/responses` : `${BASE_URL}/v1/chat/completions`
const body = PROTOCOL === 'responses' ? buildResponsesRequest() : buildCompletionsRequest()
const classify = PROTOCOL === 'responses' ? classifyResponses : classifyCompletions

console.log(`endpoint: ${endpoint}`)
console.log(`model: ${MODEL}, repeats: ${REPEATS}, rounds: ${ROUNDS}, protocol: ${PROTOCOL}`)
const counts = {}
for (let round = 1; round <= ROUNDS; round += 1) {
  const started = Date.now()
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    counts.ERROR = (counts.ERROR ?? 0) + 1
    console.log(`round ${round}: FETCH-ERROR ${String(error).slice(0, 80)}`)
    continue
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.log(`round ${round}: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 200)}`)
    continue
  }
  const verdict = classify(payload)
  counts[verdict.split(/[:(]/)[0]] = (counts[verdict.split(/[:(]/)[0]] ?? 0) + 1
  console.log(`round ${round}: ${verdict} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}
console.log(`summary: ${JSON.stringify(counts)}`)
