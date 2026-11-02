import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupConversation, turnEnding, argumentSummary, contentText, splitTurn, processSummary, durationText } from '../admin/assets/market-session-log-replay.js'
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

test('a turn shows the user and the final answer; everything in between folds into the process', () => {
  const { turns } = groupConversation(demo(DEMO_PARENT))
  const first = splitTurn(turns[0])
  assert.deepEqual(first.users.map(item => item.text), ['帮我看看 demo 项目的结构，并总结 README（测试数据）'])
  assert.equal(first.answer.step, 3)
  assert.match(first.answer.text, /三个模块/u)
  // The process is every other item in order — the answer's own step included, for its reasoning and usage.
  assert.deepEqual(first.process, turns[0].items.filter(item => item.kind !== 'user'))
  assert.ok(first.process.includes(first.answer))
  assert.equal(first.ending, null)
  assert.equal(processSummary(turns[0]), `过程 · 3 步 · 工具 3 次（list_dir、read_file ×2） · 用时 ${durationText(turns[0].endedAt - turns[0].startedAt)}`)
  assert.match(processSummary(turns[1]), /^过程 · 2 步 · 工具 1 次（run_command） · 用时 .+ · 1 次重试 · 1 次审批$/u)
  // Turn 3's answer is the last step's text, even with notes and a compaction after it.
  assert.match(splitTurn(turns[2]).answer.text, /^## 检查结果/u)
  assert.match(processSummary(turns[2]), / · 1 次上下文压缩$/u)
})

test('a turn shows its last text as it is, and says how it ended unless it simply completed', () => {
  const { turns } = groupConversation(demo(DEMO_PARENT))
  // Turn 4 failed before the model said anything.
  const failed = splitTurn(turns[3])
  assert.equal(failed.answer, null)
  assert.match(failed.ending, /^没有回答 · 出错：HTTP_500 /u)
  assert.match(processSummary(turns[3]), /^过程 · 用时 /u)
  // Turn 5 was interrupted after 「好的，」: that text is the answer, the interruption a line under it.
  const stopped = splitTurn(turns[4])
  assert.equal(stopped.answer.text, '好的，')
  assert.equal(stopped.answer.events[0].seq, 84)
  assert.ok(stopped.process.includes(stopped.answer))
  assert.equal(stopped.ending, '用户中断')
  // A turn still running shows what it has so far.
  const running = groupConversation([
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1, type: 'assistant/message', data: { step: 1, message: { content: [{ type: 'text', text: '正在看' }] } } },
  ]).turns[0]
  assert.equal(splitTurn(running).answer?.text, '正在看')
  assert.equal(splitTurn(running).ending, '未结束')
  // A completed turn that only called tools has no answer either, and says what it did.
  const toolsOnly = groupConversation([
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '列目录' }] } },
    { seq: 2, time: 2, type: 'tool/call', data: { callId: 'c', name: 'list_dir', arguments: '{}' } },
    { seq: 3, time: 3, type: 'tool/result', data: { message: { toolCallId: 'c', isError: true, content: [{ type: 'text', text: 'denied' }] } } },
    { seq: 4, time: 92_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]).turns[0]
  assert.equal(splitTurn(toolsOnly).answer, null)
  assert.equal(splitTurn(toolsOnly).ending, '没有回答 · 完成')
  assert.equal(processSummary(toolsOnly), '过程 · 工具 1 次（list_dir） · 1 次工具出错 · 用时 1 分 32 秒')
  // Only bookkeeping in between.
  const bare = groupConversation([{ seq: 0, type: 'turn/start', data: { turn: 1 } }]).turns[0]
  assert.equal(processSummary(bare), '过程 · 只有内部事件')
})

test('durations read in seconds, minutes or hours', () => {
  assert.deepEqual([durationText(12_400), durationText(92_000), durationText(7_500_000), durationText(-1), durationText(NaN)],
    ['12 秒', '1 分 32 秒', '2 小时 5 分', '', ''])
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
