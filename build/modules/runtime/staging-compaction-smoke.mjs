// Installed-runtime regression. Synthetic history and adapter only: no credentials/network.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { productStage } from '../../pipeline/paths.mjs'

export async function verifyCompactionRuntime(desktopRoot) {
  const require = createRequire(resolve(desktopRoot, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)))
  const [{ Context }, llm, sessions, { default: Projections }, { default: Meter }, { BasicCompactionEngine }] = await Promise.all([
    load('cordis'), load('dsh-llm'), load('dsh-session'), load('dsh-session-projection'), load('dsh-token-meter'), load('dsh-compaction-basic'),
  ])
  const headings = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code',
    'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context']
  const valid = headings.map((h, i) => `## ${h}\n- ${i === 0 || i === 7 ? 'Remember ORANGE-742, Hangzhou, 17.' : '(none)'}`).join('\n\n')
  let reply = 'ACK'
  let finish = { kind: 'stop' }
  let calls = 0
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100_000 } } }
    async *stream(options) {
      calls++
      assert.equal(options.purpose, 'compaction')
      assert.match(options.system, /separate, authorized/)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: finish }
    }
  }
  const ctx = new Context()
  try {
    new llm.default(ctx)
    new sessions.default(ctx)
    new Projections(ctx)
    new Meter(ctx)
    ctx.llm.registerAdapter(['synthetic'], new Adapter())
    // A small synthetic pressure threshold exercises the automatic path cheaply.
    // This is a test-only instance; product thresholds are not changed.
    const compact = new BasicCompactionEngine(ctx, { auto: false, thresholdRatio: 0.02, retainTokens: 0 })
    const session = ctx.sessions.create('product-compaction-smoke')
    let checkpoint
    let flushes = 0
    ctx.on('session/flush', current => { checkpoint = current.snapshotEvents(); flushes++ })
    for (let turn = 1; turn <= 2; turn++) {
      session.append('turn/start', { turn })
      session.append('user/message', llm.createUserMessage({
        content: [{ type: 'text', text: 'Remember ORANGE-742, Hangzhou, 17. ' + 'Synthetic verbose test context. '.repeat(200) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      if (turn === 1) session.append('request/header', { header: { config: { provider: 'synthetic', model: 'test' } }, reason: 'initial' })
      session.append('assistant/message', { stream: [], turn, step: 1,
        message: llm.createAssistantMessage({ content: [{ type: 'text', text: 'ACK' }], source: { provider: 'synthetic', model: 'test' } }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const signal = new AbortController().signal
    const agent = { session, options: { provider: 'synthetic', model: 'test' }, runMaintenance: task => task(signal) }
    const original = session.deriveMessages()
    const originalSeed = session.snapshotEvents()
    const nodes = [...session.surface.nodes]
    for (const [text, reason] of [['ACK', { kind: 'stop' }], ["I cannot comply with that request.", { kind: 'stop' }],
      [valid, { kind: 'max-tokens' }], [valid, { kind: 'error', failure: { message: 'synthetic error', code: 'TEST' } }]]) {
      reply = text
      finish = reason
      await assert.rejects(compact.compactNow(agent, signal), { code: 'summary' })
      assert.deepEqual(session.deriveMessages(), original)
      assert.deepEqual([...session.surface.nodes], nodes)
      assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0)
      assert.ok(session.snapshotEvents().findLast(event => event.type === 'compaction/end').data.error)
    }
    reply = valid
    finish = { kind: 'stop' }
    const result = await compact.compactNow(agent, signal)
    assert.ok(result.shadowedSeqs.length > 0)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1)
    assert.match(JSON.stringify(session.deriveMessages()), /ORANGE-742/)
    assert.equal(calls, 5, 'failure must not add hidden model retries')
    assert.equal(flushes, 5)
    const restored = sessions.Session.create('restored-compaction-smoke', checkpoint)
    assert.deepEqual(restored.deriveMessages(), session.deriveMessages(), 'checkpoint must survive replay')
    for (const trigger of ['pressure', 'context-overflow']) {
      const active = ctx.sessions.create(`automatic-${trigger}`, { seed: originalSeed })
      active.append('turn/start', { turn: 3 })
      const automaticAgent = { ...agent, session: active }
      const before = active.deriveMessages()
      reply = 'ACK'
      await assert.rejects(compact.compactIfNeeded(automaticAgent, trigger, signal), { code: 'INVALID_COMPACTION_SUMMARY' })
      assert.deepEqual(active.deriveMessages(), before)
      reply = valid
      const automatic = await compact.compactIfNeeded(automaticAgent, trigger, signal)
      assert.ok(automatic.shadowedSeqs.length > 0)
      assert.match(JSON.stringify(active.deriveMessages()), /ORANGE-742/)
      active.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    }
    assert.equal(calls, 9)
    console.log('Compaction smoke passed: invalid output preserves history; manual/pressure/overflow commit valid checkpoints; replay passed')
  } finally { await ctx.fiber.dispose() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyCompactionRuntime(resolve(productStage(resolve(import.meta.dirname, '../../..')), 'dsh-plugin-desktop'))
}
