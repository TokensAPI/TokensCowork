import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'
import {
  AGENT_HANDLES_RUNTIME,
  exportPrivateRouteHelpers,
  openSessionMenuOnContextMenu,
  retainAgentHandles,
  wireSessionDeleteClient,
  wireSessionDeleteHost,
} from './session-delete-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const lf = path => readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/src', path), 'utf8').replaceAll('\r\n', '\n')
const t = n => '\t'.repeat(n)

test('the Desktop Host registers the route after the private settings routes, with the shell\'s own rejection', () => {
  const source = lf('index.ts')
  const patched = wireSessionDeleteHost(source)
  assert.match(patched, /import \{ installSessionDelete \} from '\.\/tokens-session-delete\.ts'\n/u)
  const call = patched.indexOf('installSessionDelete(ctx, rendererOrigin, rejectDesktopRequest)')
  assert.ok(call > patched.indexOf('private settings route'), 'registered before the settings routes')
  assert.ok(call < patched.indexOf('path: RENDERER_BOOT_REPORT_PATH'))
  assert.ok(call > patched.indexOf("if (runtime === undefined) {"), 'only inside a Desktop launch')
  assert.throws(() => wireSessionDeleteHost(patched), /复查/u)
})

test('the settings route exports the same loopback guard and body parser it uses for Profile deletion', () => {
  const source = lf('desktop-settings-route.ts')
  const patched = exportPrivateRouteHelpers(source)
  assert.ok(patched.startsWith(source.trimEnd()))
  assert.match(patched, /export async function readPrivateDesktopJson\(/u)
  assert.match(patched, /isSameOriginLoopbackRequest\(req, expectedOrigin, true\)/u)
  assert.match(patched, /export function finishPrivateDesktopJson\(/u)
  assert.throws(() => exportPrivateRouteHelpers(patched), /复查/u)
  assert.throws(() => exportPrivateRouteHelpers(source.replace('function isSameOriginLoopbackRequest(', 'function renamed(')), /锚点/u)
})

test('the Desktop client registers the Delete row in every window mode', () => {
  const patched = wireSessionDeleteClient(lf('client/index.ts'))
  assert.match(patched, /import \{ applySessionDelete \} from '\.\/tokens-session-delete\.tsx'\n/u)
  const call = patched.indexOf('applySessionDelete(ctx)')
  assert.ok(call > patched.indexOf('registerPluginControls(ctx)'))
  assert.ok(call < patched.indexOf("if (environment.mode === 'advanced')"))
  assert.throws(() => wireSessionDeleteClient(patched), /复查/u)
})

/* ------------------------------ dsh-agent ------------------------------ */

const agentFixture = [
  'var AgentRegistry = class extends Service {',
  `${t(1)}get(id) {`,
  `${t(2)}return this.store.get(id);`,
  `${t(1)}}`,
  `${t(1)}async create(options) {`,
  `${t(2)}const ownerCtx = this.ctx;`,
  `${t(2)}const { target } = this.requireFactory();`,
  `${t(2)}const receiver = getTraceable(ownerCtx, target);`,
  `${t(2)}return Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);`,
  `${t(1)}}`,
  `${t(1)}async resume(options) {`,
  `${t(2)}const ownerCtx = this.ctx;`,
  `${t(2)}const { target } = this.requireFactory();`,
  `${t(2)}const receiver = getTraceable(ownerCtx, target);`,
  `${t(2)}return Reflect.apply(target.resume, receiver, [ownerCtx, options]);`,
  `${t(1)}}`,
  '};',
  '',
].join('\n')

test('dsh-agent keeps every create/resume handle and adds tokensReleaseAgent, idempotently', () => {
  const patched = retainAgentHandles(agentFixture)
  assert.equal(retainAgentHandles(patched), patched)
  assert.match(patched, /return tokensTrackAgentHandle\(this, await Reflect\.apply\(target\.createAgent/u)
  assert.match(patched, /return tokensTrackAgentHandle\(this, await Reflect\.apply\(target\.resume/u)
  assert.match(patched, /\ttokensReleaseAgent\(id\) \{\n\t\treturn tokensReleaseAgentHandle\(this, id\);/u)
  assert.ok(patched.indexOf('const TOKENS_AGENT_HANDLES') < patched.indexOf('var AgentRegistry'))
  assert.throws(() => retainAgentHandles(agentFixture.replace('target.resume', 'target.reopen')), /锚点/u)
})

test('a released handle is disposed once; stale and foreign Agents are reported, never disposed', async () => {
  const { tokensTrackAgentHandle, tokensReleaseAgentHandle } = new Function(
    `${AGENT_HANDLES_RUNTIME}\nreturn { tokensTrackAgentHandle, tokensReleaseAgentHandle }`,
  )()
  const live = new Map()
  const registry = { get: id => live.get(id) }
  const disposed = []
  const handleFor = (id) => {
    const agent = { id }
    live.set(id, agent)
    return { agent, dispose: async () => { disposed.push(id); live.delete(id) } }
  }
  const first = handleFor('a')
  assert.equal(tokensTrackAgentHandle(registry, first), first)
  assert.equal(await tokensReleaseAgentHandle(registry, 'a'), 'released')
  assert.equal(await tokensReleaseAgentHandle(registry, 'a'), 'absent')
  assert.deepEqual(disposed, ['a'])

  // The owner disposed it itself, then something else attached the same id without a tracked handle.
  const stale = handleFor('b')
  tokensTrackAgentHandle(registry, stale)
  live.set('b', { id: 'b' })
  assert.equal(await tokensReleaseAgentHandle(registry, 'b'), 'unowned')
  assert.deepEqual(disposed, ['a'])
})

/* ---------------------------- ui-workspace ---------------------------- */

const rowFixture = [
  `${t(2)}function WorkspaceRow({ actions }) {`,
  `${t(3)}const [menuOpen, setMenuOpen] = (0, react.useState)(false);`,
  `${t(3)}return jsx(Menu, {`,
  `${t(4)}portal: true,`,
  `${t(4)}closeOnPointerLeave: true,`,
  `${t(4)}anchor: jsx("button", { onClick: (e) => {`,
  `${t(5)}setMenuOpen((v) => !v);`,
  `${t(4)}} }),`,
  `${t(3)}});`,
  `${t(2)}}`,
  `${t(2)}function SessionNodeItem({ node, currentId, now, onOpen, onRenameRequest, renderSlot, onReveal, drag, t }) {`,
  `${t(3)}const row = node;`,
  `${t(3)}const [menuOpen, setMenuOpen] = (0, react.useState)(false);`,
  `${t(3)}return jsxs("div", {`,
  `${t(5)}"aria-description": row.archived ? t("toast.archivedNotOpenable") : void 0,`,
  `${t(5)}onClick: () => {`,
  `${t(6)}onOpen(node.id);`,
  `${t(5)}},`,
  `${t(5)}children: jsx(Menu, {`,
  `${t(8)}portal: true,`,
  `${t(8)}closeOnPointerLeave: true,`,
  `${t(8)}anchor: jsx("button", { onClick: () => {`,
  `${t(9)}setMenuOpen((v) => !v);`,
  `${t(8)}} }),`,
  `${t(5)}}),`,
  `${t(3)}});`,
  `${t(2)}}`,
  `${t(2)}function SessionHoverContent() {}`,
  '',
].join('\n')

test('right-click opens the Session row menu at the pointer; the Workspace row is untouched', () => {
  const patched = openSessionMenuOnContextMenu(rowFixture)
  assert.equal(openSessionMenuOnContextMenu(patched), patched)
  const workspaceRow = patched.slice(0, patched.indexOf('function SessionNodeItem('))
  assert.equal(workspaceRow, rowFixture.slice(0, rowFixture.indexOf('function SessionNodeItem(')))
  const sessionRow = patched.slice(patched.indexOf('function SessionNodeItem('), patched.indexOf('function SessionHoverContent'))
  assert.match(sessionRow, /onContextMenu: row\.blank \? void 0 : \(e\) => \{\s*e\.preventDefault\(\);\s*setTokensMenuPoint\(new DOMRect\(e\.clientX, e\.clientY, 0, 0\)\);\s*setMenuOpen\(true\);/u)
  assert.match(sessionRow, /closeOnPointerLeave: true,\s*getAnchorRect: tokensMenuPoint === null \? void 0 : \(\) => tokensMenuPoint,/u)
  assert.match(sessionRow, /setTokensMenuPoint\(null\);\s*setMenuOpen\(\(v\) => !v\);/u)
  assert.throws(() => openSessionMenuOnContextMenu(rowFixture.replace('onOpen(node.id);', 'onSelect(node.id);')), /锚点/u)
})

/* ----------------- 固定上游的真实安装文件（有 staging 时） ----------------- */

const stage = process.env.TOKENS_STAGE_ROOT ?? resolve(root, '.build/desktop')
const installed = name => resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai', name)
const haveStage = existsSync(installed('dsh-agent/lib/index.js')) && existsSync(installed('dsh-client-ui-workspace/lib/client.js'))

test('the installed dsh-agent and ui-workspace bundles take both patches and still parse', { skip: haveStage ? false : 'no installed staging; set TOKENS_STAGE_ROOT' }, () => {
  const agent = retainAgentHandles(readFileSync(installed('dsh-agent/lib/index.js'), 'utf8'))
  const directory = mkdtempSync(join(tmpdir(), 'session-delete-overlay-'))
  try {
    const file = join(directory, 'agent.mjs')
    writeFileSync(file, agent)
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(checked.status, 0, checked.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const client = openSessionMenuOnContextMenu(readFileSync(installed('dsh-client-ui-workspace/lib/client.js'), 'utf8'))
  assert.doesNotThrow(() => new Script(client))
  assert.equal(client.split('setTokensMenuPoint(null);').length, 2)
})
