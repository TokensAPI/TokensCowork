import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupConversation, turnEnding, argumentSummary, contentText } from '../admin/assets/market-session-log-replay.js'
import { demoSessionBatches, DEMO_PARENT, DEMO_CHILD } from '../ops/session-log-demo.mjs'

// The console's conversation view, read from the made-up demo sessions (ops/session-log-demo.mjs).
// The batches overlap the way a retrying client sends them; merge them by seq as the server does.
function demo(id) {
  const events = new Map()
  for (const { body } of demoSessionBatches({ created: 0, longLines: 50 })) {
    if (body.session.id === id) for (const event of body.events) events.set(event.seq, event)
  }
  return [...events.values()].sort((first, second) => first.seq - second.seq)
}
const groups = grouped => [grouped.opening, ...grouped.turns]
const items = grouped => groups(grouped).flatMap(group => group.items)

test('every event lands in exactly one item, in seq order, so nothing is dropped', () => {
  const events = demo(DEMO_PARENT)
  const seen = items(groupConversation(events)).flatMap(item => item.events.map(event => event.seq))
  assert.deepEqual([...seen].sort((first, second) => first - second), events.map(event => event.seq))
  assert.equal(new Set(seen).size, seen.length)
})

test('turns carry their number, timing and how they ended', () => {
  const { turns } = groupConversation(demo(DEMO_PARENT))
  assert.deepEqual(turns.map(turn => turn.turn), [1, 2, 3, 4, 5])
  assert.ok(turns.every(turn => turn.endedAt >= turn.startedAt))
  assert.deepEqual(turns.map(turn => turnEnding(turn.reason)), ['完成', '完成', '完成', '出错：HTTP_500 上游错误（测试）', '用户中断'])
  assert.equal(turnEnding(null), '未结束')
})

test('only what the person typed is a user message; injected context folds into one block', () => {
  const { turns } = groupConversation(demo(DEMO_PARENT))
  const first = turns[0].items.filter(item => item.kind !== 'internal')
  assert.deepEqual(first.slice(0, 3).map(item => item.kind), ['user', 'context', 'note'])
  assert.equal(first[0].text, '帮我看看 demo 项目的结构，并总结 README（测试数据）')
  assert.deepEqual(first[1].kinds, ['runtime-context', 'skill-catalog'])
  // Without a source kind, injected text is still recognised as context.
  const legacy = groupConversation([
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } },
    { seq: 1, type: 'user/message', data: { text: 'hello' } },
  ])
  assert.deepEqual(legacy.opening.items.map(item => item.kind), ['context', 'user'])
})

test('a model step shows its model, reasoning, answer and usage; tool calls pair with results by callId', () => {
  const { turns } = groupConversation(demo(DEMO_PARENT))
  const models = turns[0].items.filter(item => item.kind === 'model')
  assert.deepEqual(models.map(item => item.step), [1, 2, 3])
  assert.equal(models[0].model, 'tokensapi / demo-model')
  assert.match(models[0].reasoning, /^先列目录/u)
  assert.match(models[2].text, /三个模块/u)
  assert.deepEqual(models[0].usage, { input: 1200, output: 60, cacheRead: 800, cacheWrite: 0, total: 1260 })
  // call-2 and call-3 were called in that order and answered in the other; each still finds its own.
  const tools = turns[0].items.filter(item => item.kind === 'tool')
  assert.deepEqual(tools.map(item => item.name), ['list_dir', 'read_file', 'read_file'])
  assert.match(tools[1].result.text, /^# Demo/u)
  assert.match(tools[2].result.text, /"name": "demo"/u)
  assert.ok(tools.every(item => item.events.length === 2 && item.result.error === false))
  // A result whose call never arrived is still shown.
  const orphan = groupConversation([{ seq: 0, type: 'tool/result', data: { message: { toolCallId: 'x', content: [{ type: 'text', text: 'out' }] } } }])
  assert.deepEqual([orphan.opening.items[0].kind, orphan.opening.items[0].result.text], ['tool', 'out'])
})

test('meaningful events become one-line notes; bookkeeping is internal; unknown types are kept', () => {
  const grouped = groupConversation(demo(DEMO_PARENT))
  const notes = items(grouped).filter(item => item.kind === 'note').map(item => item.text)
  assert.ok(notes.includes('模型切换为 tokensapi / demo-model-large'))
  assert.ok(notes.includes('审批请求：run_command · 运行 npm test → 已批准'))
  assert.ok(notes.includes('模型请求重试 1/3：HTTP_529 上游繁忙（测试）'))
  assert.ok(notes.includes('命令 /compact → 完成'))
  assert.ok(notes.some(text => text.startsWith('上下文压缩：折叠约 18,000 token')))
  assert.ok(notes.includes('会话标题：总结 demo README（测试）'))
  assert.ok(notes.some(text => text.startsWith('交付文件 1 个')))
  assert.ok(notes.includes('待办清单更新：2 项'))
  // The model announced at start-up is not a switch.
  assert.equal(notes.filter(text => text.startsWith('模型切换')).length, 1)
  const spawn = items(grouped).find(item => item.text?.startsWith('派出子代理'))
  assert.equal(spawn.childId, DEMO_CHILD)
  const compaction = items(grouped).find(item => item.text?.startsWith('上下文压缩'))
  assert.match(compaction.detail, /^摘要：/u)
  const internal = new Set(items(grouped).filter(item => item.kind === 'internal').map(item => item.events[0].type))
  for (const type of ['agent/inbox/spliced', 'step/start', 'step/end', 'request/header', 'system/message', 'session/end-seed', 'job/registered', 'llm/retry-started']) {
    assert.ok(internal.has(type), type)
  }
  const other = items(grouped).filter(item => item.kind === 'other')
  assert.deepEqual(other.map(item => item.events[0].type), ['future/unknown-kind'])
})

test('session settings, the system prompt and a sub-agent descriptor go to the overview', () => {
  const parent = groupConversation(demo(DEMO_PARENT)).overview
  assert.deepEqual(parent.settings, { 'permission/preset': 'workspace-write', 'sandbox/mode': 'workspace-write', 'approval/policy': 'on-request' })
  assert.deepEqual(parent.systemPrompts, ['你是 demo 助手（测试用系统提示词）。\n回答要简洁。'])
  const child = groupConversation(demo(DEMO_CHILD)).overview
  assert.equal(child.descriptor.label, '检查 tests')
  assert.equal(child.settings['sandbox/mode'], 'read-only')
})

test('an event whose raw object is gone is shown as missing, not dropped', () => {
  const grouped = groupConversation([{ seq: 4, time: 1, type: 'tool/call', unavailable: true }])
  assert.deepEqual(grouped.opening.items.map(item => [item.kind, item.missing]), [['other', true]])
})

test('argument summaries are one short line; content text keeps only the parts asked for', () => {
  assert.equal(argumentSummary('{"path":"README.md","limit":20}'), 'path: README.md · limit: 20')
  assert.equal(argumentSummary('not json'), 'not json')
  assert.equal(argumentSummary(JSON.stringify({ text: 'x'.repeat(500) })).length, 161)
  const parts = [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'say' }, { type: 'image' }]
  assert.equal(contentText(parts), 'say\n[图片]')
  assert.equal(contentText(parts, ['reasoning']), 'think\n[图片]')
})
