// Made-up sessions shaped like dsh_session_log uploads (agent-hub/docs/session-log-upload-contract.md),
// used by `npm run dev` and the tests. Every message, path, id and Key here is fiction. Between them
// they cover what the console's conversation view has to read: several turns of several steps,
// reasoning and answers, parallel tool calls whose results arrive out of order, injected context,
// session settings, a model switch, an approval, a retry, a compaction, a command, a turn that
// failed and one the user stopped, a sub-agent and its own session, an unknown event type, and a
// tool result long enough that the raw view has to be shown in pieces.

export const DEMO_PARENT = 'session-00000000-0000-4000-8000-000000000001'
export const DEMO_CHILD = 'session-00000000-0000-4000-8000-000000000002'
export const DEMO_KEY = 'sk-test-direct'

const text = value => [{ type: 'text', text: value }]
const model = { provider: 'tokensapi', model: 'demo-model' }
const other = { provider: 'tokensapi', model: 'demo-model-large' }
// A final answer that uses the Markdown the console renders, plus raw HTML it must show as text.
const REPORT = [
  '## 检查结果（测试）',
  '',
  '子代理检查完毕：**12 个用例全部通过**，耗时 _3.2 秒_。',
  '',
  '| 目录 | 用例 | 结果 |',
  '| --- | ---: | :---: |',
  '| `tests/api` | 7 | 通过 |',
  '| `tests/web` | 5 | 通过 |',
  '',
  '后续建议：',
  '',
  '1. 给 `worker` 补用例',
  '   - 至少覆盖重试逻辑',
  '2. 在 CI 里跑：',
  '',
  '   ```bash',
  '   npm test -- --coverage',
  '   ```',
  '',
  '> 报告已写入 REPORT.md，详见 [测试说明](https://example.com/demo-tests)。',
  '',
  '<script>alert("不会执行")</script> 这一段 HTML 原样显示。',
].join('\n')

/** A tool result of `lines` numbered lines, about 60 bytes each. */
export function longOutput(lines) {
  return Array.from({ length: lines }, (_, index) => `${String(index + 1).padStart(5)}  demo/src/module-${index % 37}.js: 测试输出第 ${index + 1} 行`).join('\n')
}

/** `[type, data]` pairs of the parent session, in seq order. */
function parentEvents({ longLines }) {
  const step = (turn, number, content, usage, source = model) => ['assistant/message', { turn, step: number,
    message: { id: `m-${turn}-${number}`, role: 'assistant', content, source: { kind: 'model', ...source } },
    usage: { inputTokens: usage[0], outputTokens: usage[1], cacheReadTokens: usage[2] ?? 0, totalTokens: usage[0] + usage[1] } }]
  const call = (turn, number, id, name, args) => ['tool/call', { turn, step: number, callId: id, name, arguments: JSON.stringify(args) }]
  const result = (turn, number, id, output, extra = {}) => ['tool/result', { turn, step: number,
    message: { id: `r-${id}`, role: 'tool', toolCallId: id, isError: false, content: text(output), source: { kind: 'tool', callId: id } }, ...extra }]
  const context = (kind, value) => ['user/message', { id: `ctx-${kind}`, role: 'user', content: text(value), source: { kind, form: 'text' } }]
  const user = (id, value) => ['user/message', { id, role: 'user', content: text(value), source: { kind: 'user', clientTimeZone: 'Asia/Shanghai', rpcId: id } }]
  const turn = (number, body, reason = { kind: 'completed' }) => [
    ['agent/inbox/spliced', { target: 'main', start: 0, inserted: [] }],
    ['turn/start', { turn: number }],
    ...body,
    ['turn/end', { turn: number, reason }],
  ]
  const steps = (turnNumber, number, body) => [['step/start', { turn: turnNumber, step: number }], ...body, ['step/end', { turn: turnNumber, step: number }]]
  return [
    ['permission/preset', { preset: 'workspace-write' }],
    ['sandbox/mode', { mode: 'workspace-write' }],
    ['approval/policy', { policy: 'on-request' }],
    ['model/selection', model],
    ['session/end-seed', {}],
    ...turn(1, [
      ...steps(1, 1, [
        ['system/message', { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', content: text('你是 demo 助手（测试用系统提示词）。\n回答要简洁。'), source: { kind: 'system-prompt' } } }],
        user('u-1', '帮我看看 demo 项目的结构，并总结 README（测试数据）'),
        context('runtime-context', 'Current runtime context: os=win32, cwd=C:\\demo\\project（测试）'),
        context('skill-catalog', '<system-reminder>可用技能：demo-skill（测试）</system-reminder>'),
        ['request/header', { reason: 'turn', header: { config: model, tools: [{ name: 'read_file', description: '读文件', parameters: {} }] } }],
        ['request/context', { ...model, contextWindow: 128000 }],
        ['session/title', { title: '总结 demo README（测试）', messageSeqs: [], source: { kind: 'fallback' } }],
        step(1, 1, [{ type: 'reasoning', text: '先列目录，再并行读 README 和 package.json。\n第二行思考：确认文件都存在。\n第三行思考：不会显示在预览里。' },
          { type: 'tool-call', id: 'call-1', name: 'list_dir', arguments: '{"path":"."}' }], [1200, 60, 800]),
        call(1, 1, 'call-1', 'list_dir', { path: '.' }),
        result(1, 1, 'call-1', 'README.md\npackage.json\nsrc/\ntests/', { meta: { cwd: 'C:\\demo\\project' } }),
      ]),
      ...steps(1, 2, [
        step(1, 2, [{ type: 'reasoning', text: '两个文件一起读。' },
          { type: 'tool-call', id: 'call-2', name: 'read_file', arguments: '{"path":"README.md"}' },
          { type: 'tool-call', id: 'call-3', name: 'read_file', arguments: '{"path":"package.json"}' }], [1500, 90, 1200]),
        call(1, 2, 'call-2', 'read_file', { path: 'README.md' }),
        call(1, 2, 'call-3', 'read_file', { path: 'package.json' }),
        // Results arrive in the other order; they still pair by callId.
        result(1, 2, 'call-3', '{\n  "name": "demo",\n  "version": "1.0.0"\n}'),
        result(1, 2, 'call-2', '# Demo\n\n演示项目，三个模块：\n- api\n- web\n- worker\n' + '更多说明（测试）。\n'.repeat(12)),
      ]),
      ...steps(1, 3, [
        step(1, 3, [{ type: 'reasoning', text: '信息够了。' }, { type: 'text', text: 'demo 是一个演示项目，包含三个模块：\n\n1. **api**：接口\n2. **web**：页面\n3. **worker**：后台任务\n\n版本 1.0.0。' }], [2600, 120, 2000]),
      ]),
    ]),
    ...turn(2, [
      ...steps(2, 1, [
        user('u-2', '换个大模型，跑一下测试，输出全部给我看'),
        ['model/selection', other],
        context('model-selection', '模型已切换为 demo-model-large（测试）'),
        ['request/context', { ...other, contextWindow: 200000 }],
        ['assistant/attempt', { turn: 2, step: 1, stream: [] }],
        ['llm/retry', { turn: 2, step: 1, retry: 1, maxRetries: 3, delayMs: 2000, retryId: 'retry-1', mode: 'auto', policyKey: 'default',
          provider: 'tokensapi', failure: { code: 'HTTP_529', message: '上游繁忙（测试）' } }],
        ['llm/retry-started', { turn: 2, step: 1, retry: 1, retryId: 'retry-1' }],
        step(2, 1, [{ type: 'reasoning', text: '运行测试命令需要审批。' },
          { type: 'tool-call', id: 'call-4', name: 'run_command', arguments: '{"command":"npm test","timeoutMs":120000}' }], [4100, 70, 3000], other),
        call(2, 1, 'call-4', 'run_command', { command: 'npm test', timeoutMs: 120000 }),
        ['approval/asked', { id: 'ap-1', callId: 'call-4', toolName: 'run_command', reason: '运行 npm test' }],
        ['approval/decided', { id: 'ap-1', outcome: 'approved' }],
        ['job/registered', { jobId: 'job-1', kind: 'pwsh', label: 'npm test', owner: 'main', startedAt: 0, toolCall: { callId: 'call-4', rootCallId: 'call-4' } }],
        ['job/settled', { jobId: 'job-1', kind: 'pwsh', label: 'npm test', owner: 'main', status: 'succeeded', cause: 'exit', detail: '0', startedAt: 0, finishedAt: 0,
          producerReported: true, toolCall: { callId: 'call-4', rootCallId: 'call-4' } }],
        result(2, 1, 'call-4', longOutput(longLines)),
      ]),
      ...steps(2, 2, [
        step(2, 2, [{ type: 'text', text: `测试全部通过，输出共 ${longLines} 行，见上面的工具结果。` }], [9000, 40, 4000], other),
        ['future/unknown-kind', { anything: true, note: '内核以后新增的事件类型（测试）' }],
      ]),
    ]),
    ...turn(3, [
      ...steps(3, 1, [
        user('u-3', '派一个子代理去检查 tests 目录'),
        step(3, 1, [{ type: 'tool-call', id: 'call-5', name: 'spawn_agent', arguments: '{"label":"检查 tests","mode":"explore"}' }], [9500, 30, 8000], other),
        call(3, 1, 'call-5', 'spawn_agent', { label: '检查 tests', mode: 'explore' }),
        ['subagent/catalog', { childId: DEMO_CHILD, childCreatedAt: 0, label: '检查 tests', mode: 'explore', version: 1 }],
        result(3, 1, 'call-5', '子代理报告：tests 目录有 12 个用例，全部通过。'),
        ['deliverables/presented', { turn: 3, callId: 'call-5', files: [{ path: 'C:\\demo\\project\\REPORT.md', description: '测试报告（测试）' }] }],
        ['todo/write', { todos: [{ content: '检查 tests（测试）', status: 'completed' }, { content: '补文档（测试）', status: 'pending' }] }],
      ]),
      ...steps(3, 2, [
        step(3, 2, [{ type: 'text', text: REPORT }], [9800, 30, 9000], other),
      ]),
    ]),
    ['command/run', { commandId: 'cmd-1', name: 'compact', args: '', source: { kind: 'user' } }],
    ['compaction/start', { compactionId: 'cp-1', sourceCommandId: 'cmd-1', turn: null }],
    ['compaction/summary', { compactionId: 'cp-1', sourceCommandId: 'cmd-1', ...other, maxTokens: 4000, llmStreamCall: true,
      shadowedRange: { start: 0, end: 40 }, shadowedSeqs: [], shadowedTokenCount: 18000,
      summary: text('摘要：用户让助手总结 demo 项目、跑测试、派子代理检查 tests；全部完成（测试）。'), rawOutput: [],
      usage: { inputTokens: 18000, outputTokens: 200, totalTokens: 18200 } }],
    ['compaction/end', { compactionId: 'cp-1', sourceCommandId: 'cmd-1', turn: null }],
    ['command/done', { commandId: 'cmd-1', kind: 'success', text: '已压缩上下文（测试）' }],
    ...turn(4, [
      ...steps(4, 1, [
        user('u-4', '再总结一次'),
        ['assistant/attempt', { turn: 4, step: 1, stream: [] }],
      ]),
    ], { kind: 'error', error: { code: 'HTTP_500', message: '上游错误（测试）' } }),
    ...turn(5, [
      ...steps(5, 1, [
        user('u-5', '算了，先停下'),
        step(5, 1, [{ type: 'text', text: '好的，' }], [300, 3]),
      ]),
    ], { kind: 'aborted', reason: { kind: 'user' } }),
  ]
}

function childEvents() {
  return [
    ['subagent/descriptor', { label: '检查 tests', mode: 'explore', provider: 'tokensapi', agentProvider: 'tokensapi', agentModel: 'demo-model', version: 1 }],
    ['sandbox/mode', { mode: 'read-only' }],
    ['approval/policy', { policy: 'never' }],
    ['turn/start', { turn: 1 }],
    ['user/message', { id: 'c-u-1', role: 'user', content: text('检查 tests 目录，报告用例数量（测试）'), source: { kind: 'user' } }],
    ['assistant/message', { turn: 1, step: 1, message: { id: 'c-m-1', role: 'assistant', content: text('tests 目录有 12 个用例，全部通过。'),
      source: { kind: 'model', ...model } }, usage: { inputTokens: 800, outputTokens: 20, totalTokens: 820 } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ]
}

/**
 * The upload batches for both sessions: `[{ key, body }]`, bodies in the upload format. The parent
 * goes up in three overlapping batches (as a client retrying would send), the child anonymously.
 */
export function demoSessionBatches({ created = Date.now() - 2 * 60 * 60 * 1000, longLines = 30000 } = {}) {
  const at = seq => created + seq * 4000
  const envelope = (session, events, afterSeq) => ({ version: 1, sessionFormatVersion: 4, session, afterSeq, throughSeq: events.at(-1).seq,
    events, client: { product: 'TokensCowork', version: '0.7.8', platform: 'win32' }, account: { id: '5001' } })
  const parent = parentEvents({ longLines }).map(([type, data], seq) => ({ seq, time: at(seq), type, data }))
  const child = childEvents().map(([type, data], seq) => ({ seq, time: at(60 + seq), type, data }))
  const session = { id: DEMO_PARENT, createdAt: created, cwd: 'C:\\demo\\project', delegationDepth: 0 }
  const third = Math.floor(parent.length / 3)
  return [
    { key: DEMO_KEY, body: envelope(session, parent.slice(0, third + 5), -1) },
    { key: DEMO_KEY, body: envelope(session, parent.slice(third, 2 * third), third - 1) },
    { key: DEMO_KEY, body: envelope(session, parent.slice(2 * third), 2 * third - 1) },
    { key: null, body: envelope({ id: DEMO_CHILD, createdAt: at(60), cwd: 'C:\\demo\\project', parentSession: DEMO_PARENT, delegationDepth: 1 }, child, -1) },
  ]
}
