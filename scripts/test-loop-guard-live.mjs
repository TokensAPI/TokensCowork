#!/usr/bin/env node
/* ====================================================================
 * tokens-loop-guard 端到端验证(真实插件代码 × 真实模型)
 *
 * 用一个最小 agent 循环驱动器替代完整 harness:
 *   模型(responses 协议)→ function_call → 模拟执行(罐头结果)
 *   → 经过 tokens-loop-guard 的 tools/post-execute 监听器
 *   → accept(附提醒)/ block(替换为纠错反馈)→ 历史回灌 → 下一轮
 *
 * 用法:
 *   node scripts/test-loop-guard-live.mjs --plugin <插件目录> [--url http://127.0.0.1:8081]
 *       [--guard off] [--max-steps 25] [--prime 8] [--temperature 0.1] [--replay-reasoning]
 *
 * --plugin 指向 tokens-loop-guard 插件目录(含 index.js/identity.js);
 * 默认依次尝试:环境变量 LOOP_GUARD_PLUGIN → 本仓库 feature/loop-guard 分支的
 * 插件子模块路径(plugins/tokens_DshLoopGuard_code)。
 * 插件依赖 @deepseek-ai/schemastery,需能在插件目录向上解析到
 * (如在 .build/desktop 装配产物内,或插件目录里 npm install 过)。
 * ==================================================================== */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}
const GUARD_ON = argValue('--guard', 'on') !== 'off'
const MAX_STEPS = Number(argValue('--max-steps', 25))
const BASE_URL = argValue('--url', 'http://127.0.0.1:8081').replace(/\/$/, '')
const TEMPERATURE = args.includes('--temperature') ? Number(argValue('--temperature')) : undefined
const PRIME = Number(argValue('--prime', 0))
const REPLAY_REASONING = args.includes('--replay-reasoning')

const pluginDir = resolve(argValue('--plugin', process.env.LOOP_GUARD_PLUGIN ?? 'plugins/tokens_DshLoopGuard_code'))
if (!existsSync(resolve(pluginDir, 'index.js'))) {
  throw new Error(`找不到 tokens-loop-guard 插件目录: ${pluginDir}\n用 --plugin <dir> 指定(含 index.js 与 identity.js 的目录)`)
}
const { apply } = await import(pathToFileURL(resolve(pluginDir, 'index.js')).href)
const {
  REMIND_THRESHOLDS, BLOCK_THRESHOLD, FUZZY_REMIND_THRESHOLDS, FUZZY_BLOCK_THRESHOLD,
  FUZZY_TOOLS, INCLUDE, EXCLUDE, ARGUMENTS_PREVIEW_CHARS,
} = await import(pathToFileURL(resolve(pluginDir, 'identity.js')).href)

/* ---- 挂载真实插件 ---- */
const listeners = []
const ctx = { on: (event, fn) => listeners.push({ event, fn }) }
apply(ctx, {
  remindThresholds: REMIND_THRESHOLDS, blockThreshold: BLOCK_THRESHOLD,
  fuzzyRemindThresholds: FUZZY_REMIND_THRESHOLDS, fuzzyBlockThreshold: FUZZY_BLOCK_THRESHOLD,
  fuzzyTools: FUZZY_TOOLS, include: INCLUDE, exclude: EXCLUDE,
  argumentsPreviewChars: ARGUMENTS_PREVIEW_CHARS,
})
const postExecute = listeners.find(l => l.event === 'tools/post-execute')?.fn
const agent = {}

/* ---- 罐头执行结果(模拟不推进的环境) ---- */
const CANNED_OUTPUT = `1:import { assertDesktopProfileName } from "./profile-manager.js";
2:import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
4:import { PROFILE_TEMPLATES, resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
33:var DesktopPluginsError = class extends Error {
44:		profiles: []`

const TOOLS = [{
  type: 'function',
  name: 'bash',
  description: 'Execute a bash command (`bash -c`) and return its stdout/stderr.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['command'],
  },
}]

const input = [{
  type: 'message', role: 'user',
  content: [{ type: 'input_text', text: '帮我链接一下notion' }],
}]

/* ---- 预置 N 轮完全相同的调用/结果(复刻 session.jsonl 循环段) ---- */
const LOOP_CALL_ARGS = JSON.stringify({ command: 'grep -n "plugin\\|Plugin\\|node_modules\\|require\\|import" /Applications/TokensHarness.app/Contents/Resources/app.asar.unpacked/lib/desktop-plugins.js 2>/dev/null | head -40', description: 'Inspect desktop-plugins.js plugin loading logic' })
for (let index = 0; index < PRIME; index += 1) {
  input.push({ type: 'function_call', id: `fc_p${index}`, call_id: `call_p${index}`, name: 'bash', arguments: LOOP_CALL_ARGS })
  input.push({ type: 'function_call_output', call_id: `call_p${index}`, output: CANNED_OUTPUT })
}

let blockedCount = 0
let remindedCount = 0
for (let step = 1; step <= MAX_STEPS; step += 1) {
  const response = await fetch(`${BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', store: false, max_output_tokens: 2000, ...TEMPERATURE === undefined ? {} : { temperature: TEMPERATURE }, input, tools: TOOLS }),
    signal: AbortSignal.timeout(120_000),
  })
  const payload = await response.json()
  if (!response.ok) { console.log(`step ${step}: HTTP ${response.status}`); break }
  const call = (payload.output ?? []).find(item => item.type === 'function_call')
  const textItem = (payload.output ?? []).find(item => item.type === 'message')
  const reasoningItem = (payload.output ?? []).find(item => item.type === 'reasoning')

  if (!call) {
    const text = textItem?.content?.find(c => c.type === 'output_text')?.text ?? ''
    console.log(`\nstep ${step}: 模型停止调用工具,输出文本:`)
    console.log(text.slice(0, 600))
    break
  }

  const argsText = call.arguments ?? ''
  const short = argsText.slice(0, 90)
  if (REPLAY_REASONING && reasoningItem) input.push(reasoningItem)
  input.push({ type: 'function_call', id: call.id, call_id: call.call_id, name: call.name, arguments: argsText })

  /* ---- 经过 loop-guard(或直通) ---- */
  let outputText = CANNED_OUTPUT
  let verdict = 'exec'
  if (GUARD_ON) {
    const decision = await postExecute(
      { agent, name: call.name, arguments: argsText }, {},
      async () => ({ kind: 'accept' }),
    )
    if (decision.kind === 'block') {
      verdict = 'BLOCKED'
      blockedCount += 1
      outputText = decision.feedback.map(b => b.text).join('\n')
      for (const ctxMsg of decision.additionalContexts ?? []) {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: ctxMsg.content.map(c => c.text ?? '').join('\n') }] })
      }
    } else {
      for (const ctxMsg of decision.additionalContexts ?? []) {
        verdict = 'reminded'
        remindedCount += 1
        input.push({ type: 'function_call_output', call_id: call.call_id, output: outputText })
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: ctxMsg.content.map(c => c.text ?? '').join('\n') }] })
        outputText = null
      }
    }
  }
  if (outputText !== null) {
    input.push({ type: 'function_call_output', call_id: call.call_id, output: outputText })
  }
  console.log(`step ${step}: ${verdict} ${short}`)
}
console.log(`\nsummary: guard=${GUARD_ON ? 'on' : 'off'}, reminded=${remindedCount}, blocked=${blockedCount}`)
