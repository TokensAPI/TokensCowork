/* ====================================================================
 * 真实宿主冒烟：永久删除会话（T0069）
 * 不修改 staging。用 staging 里装好的 DSH 宿主起一个临时 DSH_HOME（自带假模型服务），
 * 本文件同时充当插进宿主的探针插件，在真实的 sessions / agents / sessionPersistence /
 * workspaceRegistry / sessionController 上跑产品自己的删除代码（assets/session-delete-core.ts），
 * dsh-agent 覆盖用同一段运行时片段（AGENT_HANDLES_RUNTIME）装到 AgentRegistry 原型上。
 * 只碰临时目录里现造的测试会话，绝不读写 ~/.dsh。
 *
 * 用法：node build/modules/session/staging-session-delete-smoke.mjs <宿主根>
 *   宿主根 = 含 node_modules/@deepseek-ai/dsh 的目录，如 .build/desktop/dsh-plugin-desktop
 * ==================================================================== */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const CORE_URL = pathToFileURL(resolve(import.meta.dirname, 'assets', 'session-delete-core.ts')).href
const OVERLAY_URL = pathToFileURL(resolve(import.meta.dirname, 'session-delete-overlay.mjs')).href
const PROFILE = 'tokens-session-delete-smoke'
const PROBE = 'tokens-session-delete-smoke-probe'
const BOOT_TIMEOUT_MS = 300_000
const READY_TIMEOUT_MS = 120_000
const TURN_TIMEOUT_MS = 60_000

const wait = ms => new Promise(settle => { setTimeout(settle, ms).unref?.() })

function describe(error, depth = 0) {
  if (typeof error !== 'object' || error === null) return { message: String(error) }
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    ...(error.cause !== undefined && depth < 2 ? { cause: describe(error.cause, depth + 1) } : {}),
  }
}

/* ============================ 探针（宿主进程内） ============================ */

export const name = PROBE
export const inject = []

export function apply(ctx) {
  const report = { steps: [], warnings: [] }
  const finish = (extra = {}) => {
    writeFileSync(process.env.TOKENS_SESSION_DELETE_SMOKE_REPORT, JSON.stringify({ ...report, ...extra }, null, 2))
    setTimeout(() => process.exit(0), 100).unref?.()
  }
  ctx.logger.exporter({
    levels: { default: 2 },
    export: (message) => {
      if (message.level <= 2) report.warnings.push(message.args.map(String).join(' ').slice(0, 400))
    },
  })
  const timer = setTimeout(() => finish({ fatal: 'the Host services never became ready' }), READY_TIMEOUT_MS)
  timer.unref?.()
  ctx.inject(['sessions', 'agents', 'agentDefaultModel', 'workspaceRegistry', 'sessionPersistence', 'sessionController'], (ready) => {
    clearTimeout(timer)
    probe(ready, report).then(() => finish(), error => finish({ fatal: describe(error) }))
  })
}

async function probe(ctx, report) {
  const hostRoot = process.env.TOKENS_SESSION_DELETE_SMOKE_HOST_ROOT
  const hostImport = specifier => import(pathToFileURL(createRequire(join(hostRoot, 'package.json')).resolve(specifier)).href)
  const agentModule = await hostImport('@deepseek-ai/dsh-agent')
  const llm = await hostImport('@deepseek-ai/dsh-llm')
  const core = await import(CORE_URL)
  const { AGENT_HANDLES_RUNTIME } = await import(OVERLAY_URL)

  // The same runtime the session.agent-handles overlay writes into dsh-agent, installed on the live class.
  // oxlint-disable-next-line no-new-func -- evaluates the overlay's own snippet verbatim.
  const runtime = new Function(`${AGENT_HANDLES_RUNTIME}\nreturn { tokensTrackAgentHandle, tokensReleaseAgentHandle }`)()
  const proto = agentModule.AgentRegistry.prototype
  const originalCreate = proto.create
  const originalResume = proto.resume
  Object.defineProperty(proto, 'create', { configurable: true, writable: true, value: async function create(options) {
    return runtime.tokensTrackAgentHandle(this, await originalCreate.call(this, options))
  } })
  Object.defineProperty(proto, 'resume', { configurable: true, writable: true, value: async function resume(options) {
    return runtime.tokensTrackAgentHandle(this, await originalResume.call(this, options))
  } })
  Object.defineProperty(proto, 'tokensReleaseAgent', { configurable: true, writable: true, value: function tokensReleaseAgent(id) {
    return runtime.tokensReleaseAgentHandle(this, id)
  } })

  const home = process.env.DSH_HOME
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  const selection = ctx.agentDefaultModel.currentSelection()
  const registry = ctx.workspaceRegistry
  const persistence = ctx.sessionPersistence
  const root = persistence.config.root
  if (!resolve(root).startsWith(resolve(home))) throw new Error(`session root ${root} is outside the temporary DSH_HOME`)
  const workspace = await registry.create(cwd)

  const ask = async (agent, text) => {
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await Promise.race([agent.whenIdle(), wait(TURN_TIMEOUT_MS).then(() => { throw new Error('turn timed out') })])
  }
  /** A stored, materialized Session that no Agent holds (closed through the probe's own handle). */
  const coldSession = async (id) => {
    const handle = await ctx.agents.create({
      sessionId: id,
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => { agentModule.installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
    })
    await ask(handle.agent, 'ping')
    await handle.dispose()
    await workspace.attachSession(id)
  }
  /** Open the Session the way the Desktop UI does: session-controller resumes it and keeps no handle. */
  const openLikeTheUi = async (id) => {
    const result = await ctx.sessionController.resolveAgent(id)
    if ('error' in result) throw result.error
    return result.agent
  }
  const leaseHeld = async (id) => {
    try {
      const handle = await persistence.open(id, 'write')
      await handle.close()
      return false
    } catch (error) {
      if (error?.name === 'SessionAlreadyOwnedError') return true
      throw error
    }
  }
  const directoryOf = async id => core.sessionDirectory(root, (await persistence.stat(id))?.header ?? { id, cwd })
  /** Everything that must be true once a Session is gone. */
  const gone = async (id, directory) => {
    const resolved = await ctx.sessionController.resolveAgent(id).then(
      value => ('error' in value ? { error: value.error?.name ?? String(value.error) } : { agent: true }),
      error => ({ threw: describe(error) }),
    )
    const listed = (await ctx.sessionController.list({})).items ?? (await ctx.sessionController.list({}))
    return {
      directoryExists: existsSync(directory),
      stat: (await persistence.stat(id)) !== undefined,
      persistenceList: (await persistence.list()).some(snapshot => snapshot.header.id === id),
      liveSession: ctx.sessions.get(id) !== undefined,
      liveAgent: ctx.agents.get(id) !== undefined,
      archived: registry.archivedSessionIds.includes(id),
      pinned: registry.pinnedSessionIds.includes(id),
      accounted: registry.list().some(item => item.sessionIds.includes(id)),
      controllerList: Array.isArray(listed) ? listed.some(item => item.sessionId === id) : JSON.stringify(listed).includes(id),
      resolveAfterDelete: resolved,
    }
  }
  const step = async (id, run) => {
    try {
      report.steps.push({ id, ok: true, value: await run() })
    } catch (error) {
      report.steps.push({ id, ok: false, error: describe(error) })
    }
  }
  const remove = (id, options) => core.deleteSession(core.bindSessionDeleteHost(ctx), id, options)

  await step('cold', async () => {
    const id = 'session-smoke-cold'
    await coldSession(id)
    await registry.pinSession(id)
    const directory = await directoryOf(id)
    const before = { directoryExists: existsSync(directory), pinned: registry.pinnedSessionIds.includes(id), accounted: workspace.sessionIds.includes(id) }
    const result = await remove(id)
    return { before, result, after: await gone(id, directory) }
  })

  await step('repeat', async () => ({ result: await remove('session-smoke-cold') }))

  await step('opened-by-ui', async () => {
    const id = 'session-smoke-open'
    await coldSession(id)
    const agent = await openLikeTheUi(id)
    await ask(agent, 'ping again')
    const directory = await directoryOf(id)
    const before = { leaseHeld: await leaseHeld(id), liveAgent: ctx.agents.get(id) !== undefined }
    const result = await remove(id)
    return { before, result, after: await gone(id, directory) }
  })

  await step('running', async () => {
    const id = 'session-smoke-running'
    await coldSession(id)
    const agent = await openLikeTheUi(id)
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'TOKENS_SMOKE_HANG' }], source: { kind: 'user' } }))
    const deadline = Date.now() + 10_000
    while (agent.status !== 'running' && Date.now() < deadline) await wait(50)
    const directory = await directoryOf(id)
    const before = { status: agent.status, leaseHeld: await leaseHeld(id) }
    const started = Date.now()
    const result = await remove(id)
    return { before, result, elapsedMs: Date.now() - started, after: await gone(id, directory) }
  })

  // Informative only: removing the directory under a live writer, as a deletion without the release would.
  await step('hazard-without-release', async () => {
    const id = 'session-smoke-hazard'
    await coldSession(id)
    const agent = await openLikeTheUi(id)
    const directory = await directoryOf(id)
    const removal = await rm(directory, { recursive: true, force: false }).then(() => 'removed', error => describe(error))
    const afterRemoval = existsSync(directory)
    const turn = await ask(agent, 'still there?').then(() => 'ok', error => describe(error))
    await ctx.sessions.flush(agent.session).catch(() => {})
    const reappeared = existsSync(directory)
    const result = await remove(id).catch(error => ({ error: describe(error) }))
    return { removal, afterRemoval, turn, reappeared, cleanup: result, after: await gone(id, directory) }
  })
}

/* ============================ 启动器（命令行） ============================ */

function startModel() {
  const hanging = new Set()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      if (!request.url.endsWith('/chat/completions')) { response.writeHead(404).end(); return }
      const body = Buffer.concat(chunks).toString('utf8')
      const frame = (choices, extra = {}) => `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices, ...extra })}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(frame([{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }]))
      // The last user message asks to hang: keep the stream open until the client goes away.
      const messages = JSON.parse(body).messages ?? []
      const last = JSON.stringify(messages.filter(item => item.role === 'user').at(-1) ?? '')
      if (last.includes('TOKENS_SMOKE_HANG')) { hanging.add(response); response.on('close', () => hanging.delete(response)); return }
      response.write(frame([{ index: 0, delta: {}, finish_reason: 'stop' }]))
      response.write(frame([], { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }))
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((settle) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      settle({
        baseURL: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => { for (const response of hanging) response.destroy(); server.closeAllConnections?.(); server.close(() => done()) }),
      })
    })
  })
}

function composeHome(hostRoot, model) {
  const home = mkdtempSync(join(tmpdir(), 'tokens-session-delete-smoke-'))
  const probe = join(home, 'node_modules', PROBE)
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'package.json'), `${JSON.stringify({ name: PROBE, version: '0.0.0', private: true, type: 'module', main: 'index.mjs', exports: { '.': './index.mjs' } }, null, 2)}\n`)
  writeFileSync(join(probe, 'index.mjs'), `export * from ${JSON.stringify(pathToFileURL(SELF).href)};\n`)
  const profile = join(home, 'profiles', PROFILE)
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: web-runtime', '  config:', '    openBrowser: false', '    printUrl: false', '',
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-completions',
    `        baseURL: ${model.baseURL}`, '        apiKeyEnv: MOCK_LLM_API_KEY', '        models:', '          - id: mock-model', '',
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: mock-model', '',
    '- insert:', `    - id: ${PROBE}`, `      name: ${PROBE}`, '',
  ].join('\n'))
  symlinkSync(join(hostRoot, 'node_modules', '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')
  return home
}

function launch(hostRoot, home, reportPath) {
  return new Promise((settle) => {
    const launcher = resolve(createRequire(join(hostRoot, 'package.json')).resolve('@deepseek-ai/dsh/package.json'), '..', 'lib/bin.js')
    const child = spawn(process.execPath, [launcher, '--profile', PROFILE, '--port', '0', '--no-open'], {
      cwd: home,
      env: {
        ...process.env,
        DSH_HOME: home,
        MOCK_LLM_API_KEY: 'mock-llm-key',
        TOKENS_SESSION_DELETE_SMOKE_REPORT: reportPath,
        TOKENS_SESSION_DELETE_SMOKE_HOST_ROOT: hostRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => { output = (output + chunk).slice(-200_000) }
    child.stdout.setEncoding('utf8').on('data', collect)
    child.stderr.setEncoding('utf8').on('data', collect)
    const timer = setTimeout(() => { child.kill('SIGKILL'); settle({ output, timedOut: true }) }, BOOT_TIMEOUT_MS)
    child.on('exit', (code) => { clearTimeout(timer); settle({ output, code }) })
  })
}

/** What every deleted Session must look like afterwards. */
function assertGone(label, after, failures) {
  for (const key of ['directoryExists', 'stat', 'persistenceList', 'liveSession', 'liveAgent', 'archived', 'pinned', 'accounted', 'controllerList']) {
    if (after[key] !== false) failures.push(`${label}: ${key} is ${JSON.stringify(after[key])} after deletion`)
  }
  if (after.resolveAfterDelete.agent === true) failures.push(`${label}: session-controller resumed the deleted session`)
}

async function main() {
  const hostRoot = resolve(process.argv[2] ?? '')
  if (!existsSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
    throw new Error('usage: staging-session-delete-smoke.mjs <host root holding node_modules/@deepseek-ai/dsh>')
  }
  const model = await startModel()
  const home = composeHome(hostRoot, model)
  const reportPath = join(home, 'report.json')
  const run = await launch(hostRoot, home, reportPath)
  await model.close()
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined
  if (report === undefined) throw new Error(`the Host never reported:\n${run.output.slice(-4000)}`)
  console.log(JSON.stringify(report, null, 2))
  const failures = []
  if (report.fatal !== undefined) failures.push(`fatal: ${JSON.stringify(report.fatal)}`)
  const value = id => {
    const found = report.steps.find(step => step.id === id)
    if (found === undefined || !found.ok) { failures.push(`${id}: ${JSON.stringify(found?.error ?? 'missing')}`); return undefined }
    return found.value
  }
  const cold = value('cold')
  if (cold) {
    if (!cold.before.directoryExists || !cold.before.pinned || !cold.before.accounted) failures.push(`cold: setup incomplete ${JSON.stringify(cold.before)}`)
    if (JSON.stringify(cold.result.deleted) !== '["session-smoke-cold"]') failures.push(`cold: deleted ${JSON.stringify(cold.result.deleted)}`)
    assertGone('cold', cold.after, failures)
  }
  const repeat = value('repeat')
  if (repeat && repeat.result.deleted.length !== 0) failures.push('repeat: a second deletion removed something')
  const opened = value('opened-by-ui')
  if (opened) {
    if (!opened.before.leaseHeld || !opened.before.liveAgent) failures.push(`opened-by-ui: the UI path did not hold the session ${JSON.stringify(opened.before)}`)
    assertGone('opened-by-ui', opened.after, failures)
  }
  const running = value('running')
  if (running) {
    if (running.before.status !== 'running' || !running.before.leaseHeld) failures.push(`running: setup ${JSON.stringify(running.before)}`)
    assertGone('running', running.after, failures)
  }
  // The removal under a live writer is only observed; the deletion that follows must still clean up.
  const hazard = value('hazard-without-release')
  if (hazard) {
    if (hazard.cleanup.error !== undefined) failures.push(`hazard cleanup: ${JSON.stringify(hazard.cleanup.error)}`)
    assertGone('hazard cleanup', hazard.after, failures)
  }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch { /* a Host still exiting may hold a handle */ }
  if (failures.length > 0) {
    console.error(`\nsession delete smoke FAILED:\n- ${failures.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log('\nsession delete smoke passed: cold, repeat, opened-by-ui, running, hazard cleanup')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
