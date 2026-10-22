import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { addMarketHome, addMarketPluginsTab } from './market-home-overlay.mjs'
import { addMarketRestartPrompt, RESTART_REASONS, RESTART_ROUTE, SHARED_MODULE_REASONS } from './market-restart-overlay.mjs'
import { addMarketUpdates } from './market-update-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const upstream = path => readFileSync(resolve(root, 'desktop/dsh-community-market', path), 'utf8')

/**
 * 重启提示排在插件更新与发现页之后：它要接的那条完成路径里已经有「更新」，
 * 横幅要落在插件页「发现」标签也不渲染视图栏的位置上，所以按装配顺序叠出
 * 真实 staging 的形态，再把本覆盖应用上去。
 */
function input() {
  const updated = addMarketUpdates({
    service: upstream('src/install/service.ts'),
    routes: upstream('src/host/routes.ts'),
    types: upstream('src/api-types.ts'),
    settingsTab: upstream('src/client/MarketSettingsTab.tsx'),
    locales: upstream('src/client/locales.ts'),
  })
  const home = addMarketHome({ settingsTab: updated.settingsTab, locales: updated.locales })
  const tabbed = addMarketPluginsTab({ clientIndex: upstream('src/client/index.ts'), settingsTab: home.settingsTab })
  return {
    types: updated.types,
    service: updated.service,
    routes: updated.routes,
    index: upstream('src/index.ts'),
    api: upstream('src/client/api.ts'),
    settingsTab: tabbed.settingsTab,
    locales: home.locales,
    styles: upstream('src/client/styles.ts'),
  }
}

/** 从加工后的源码里取出整段实现并执行，而不是只比对字符串。 */
function evaluate(source, pattern, expression, scope = {}, declare = text => text) {
  const match = source.match(pattern)
  assert.ok(match, `生成的源码里找不到 ${pattern}`)
  const body = declare((match[1] ?? match[0])
    .replace(/^ {2}private async (\w+)/u, 'async function $1')
    .replace(/^ {2}private (\w+)/u, 'function $1')
    .replace(/^ {2}const (\w+) = /u, 'const $1 = '))
  const names = Object.keys(scope)
  return new Function(...names, `${stripTypeScriptTypes(body)}\nreturn (${expression})`)(...names.map(name => scope[name]))
}

test('the product restart reasons are the official plugin manager own, not a hand-kept copy', () => {
  // 产品在渲染层契约里重声明了这个联合类型（api-types 不依赖宿主包）；
  // 上游加一个原因就在这里报错，而不是等界面上出现一个显示不出来的取值。
  const types = readFileSync(
    resolve(root, 'desktop/deepseek-harness/packages/boot/plugin-manager/src/types.ts'), 'utf8',
  ).match(/export type RestartReason = ([^\n]+)\n/u)
  assert.ok(types)
  assert.deepEqual(types[1].split('|').map(value => value.trim().replaceAll("'", '')), RESTART_REASONS)
  // 「共享模块没换掉」只是其中两种，其余原因不该借用那段文案。
  assert.ok(SHARED_MODULE_REASONS.every(reason => RESTART_REASONS.includes(reason)))
  assert.ok(SHARED_MODULE_REASONS.length < RESTART_REASONS.length)
  const { types: generated } = addMarketRestartPrompt(input())
  assert.match(generated, new RegExp(`export type MarketRestartReason = ${RESTART_REASONS.map(r => `'${r}'`).join(' \\| ')}`, 'u'))
})

test('the Host records every change it could not apply and reports the reason once', () => {
  const { service, types } = addMarketRestartPrompt(input())
  const pendingRestarts = new Map()
  const facts = evaluate(service, / {2}private restartFacts\([\s\S]*?\n {2}\}/u, 'restartFacts')
  const list = evaluate(service, / {2}listPendingRestarts\(\)[\s\S]*?\n {2}\}/u, 'listPendingRestarts', {},
    source => `function ${source.trimStart()}`)
  const host = { pendingRestarts, restartFacts: facts, listPendingRestarts: list }

  // 热更新换不掉已加载的共享依赖：宿主把它报成 restart-required + module-comparison。
  assert.deepEqual(facts.call(host, '@tokensapi/dsh-connect', { application: 'restart-required', restartReason: 'module-comparison' }),
    { restartReason: 'module-comparison' })
  // 真正即时生效的变更不记、也一个字都不多说。
  assert.deepEqual(facts.call(host, '@tokensapi/other', { application: 'applied' }), {})
  // 官方管理器只在 restart-required 时留原因；万一留了陈旧值也不往界面送。
  assert.deepEqual(facts.call(host, '@tokensapi/other', { application: 'applied', restartReason: 'no-hmr' }), {})
  assert.deepEqual(facts.call(host, '@tokensapi/other', { application: 'overridden', restartReason: 'no-hmr' }), {})
  // 没给原因的待重启照样要记下来，只是文案退回通用说法。
  assert.deepEqual(facts.call(host, '@tokensapi/plain', { application: 'restart-required' }), {})
  assert.deepEqual(list.call(host), [
    { packageName: '@tokensapi/dsh-connect', reason: 'module-comparison' },
    { packageName: '@tokensapi/plain' },
  ])

  // 安装、更新、卸载、启停四条完成路径都记录，少一条就只有部分操作会提示。
  assert.equal(service.split('...this.restartFacts(').length - 1, 4)
  // 清单跟着状态端点走，渲染层重新挂载时还问得到。
  assert.match(service, /listPendingRestarts\(\): readonly MarketPendingRestart\[\]/u)
  // Profile 服务被换掉时清单一起走，不会把上一个 Profile 的待重启带过去。
  assert.match(service, /this\.intents\.clear\(\)\n {4}this\.pendingRestarts\.clear\(\)/u)
  // 四种完成响应的契约里都有这个字段，渲染层读哪一条都不会是 undefined 类型。
  assert.equal(types.split('readonly restartReason?: MarketRestartReason').length - 1, 4)
})

test('the restart endpoint acknowledges the renderer before it queues the relaunch', async () => {
  const { routes } = addMarketRestartPrompt(input())
  assert.match(routes, new RegExp(`const ROUTE_RESTART = '${RESTART_ROUTE}'`, 'u'))
  const order = []
  let actions = { requestRestart: async () => { order.push('restart') } }
  const res = {
    destroyed: false,
    writableFinished: false,
    once: (event, listener) => { if (event === 'finish') listener() },
  }
  const scope = {
    ROUTE_RESTART: RESTART_ROUTE,
    desktopActionsProvider: { get: () => actions },
    generationController: new AbortController(),
    expectedPort: 1,
    ctx: { logger: { error: () => {} } },
    mutationAllowed: () => true,
    abortOnDisconnect: () => () => {},
    readOperationJson: async () => ({}),
    asEmptyDesktopAction: () => {},
    sendInstallError: () => { order.push('error') },
    sendJson: (_res, status, value) => {
      order.push(`json:${status}:${JSON.stringify(value)}`)
      res.writableFinished = true
    },
  }
  const handler = evaluate(routes, /path: ROUTE_RESTART, handler: (async \(req, res\) => \{[\s\S]*?\n {6}\})\}\),/u,
    'handler', scope, source => `const handler = ${source}`)

  await handler({ method: 'POST' }, res)
  // 重启确认是原生对话框、确认后进程就走了：回执必须先出去，否则按钮会卡住。
  assert.deepEqual(order, ['json:200:{"ok":true}', 'restart'])

  order.length = 0
  res.writableFinished = false
  await handler({ method: 'GET' }, res)
  assert.deepEqual(order, ['json:405:{"error":"restarting requires a local same-origin POST"}'])

  order.length = 0
  actions = {}
  await handler({ method: 'POST' }, res)
  assert.deepEqual(order, ['json:503:{"error":"desktop actions are unavailable"}'])
})

test('the banner names every plugin still waiting and only says “shared modules” when that is why', () => {
  const { settingsTab, locales } = addMarketRestartPrompt(input())
  const withPending = evaluate(settingsTab, /^function withPendingRestart\([\s\S]*?\n\}/mu, 'withPendingRestart')
  const shared = evaluate(settingsTab, /^function sharedModulesPending\([\s\S]*?\n\}/mu, 'sharedModulesPending')

  // 宿主报的清单先在，本次变更追加上去；同一个插件再变一次只留最新那条。
  let pending = withPending([{ packageName: '@tokensapi/dsh-connect', reason: 'no-hmr' }], '@tokensapi/other')
  pending = withPending(pending, '@tokensapi/dsh-connect', 'module-comparison')
  assert.deepEqual(pending, [
    { packageName: '@tokensapi/other' },
    { packageName: '@tokensapi/dsh-connect', reason: 'module-comparison' },
  ])
  assert.equal(shared(pending), true)
  assert.equal(shared([{ packageName: '@tokensapi/other' }]), false)
  assert.equal(shared([{ packageName: '@tokensapi/other', reason: 'no-hmr' }]), false)

  // 即时生效的变更不进清单。
  const noted = evaluate(settingsTab, / {2}(const notePendingRestart = \([\s\S]*?\n {2}\})/u, 'notePendingRestart',
    { withPendingRestart: withPending, setRestartPending: update => { pending = update(pending) } })
  const before = pending
  noted('@tokensapi/applied', 'applied', undefined)
  assert.equal(pending, before)
  noted('@tokensapi/applied', 'restart-required', 'module-comparison')
  assert.deepEqual(pending.at(-1), { packageName: '@tokensapi/applied', reason: 'module-comparison' })

  // 两条完成路径（安装/更新/卸载、启停）都记录，横幅在视图栏之前——插件页的
  // 「发现」标签不渲染视图栏，那一格同样看得到。
  assert.equal(settingsTab.split('notePendingRestart(result.packageName, result.application, result.restartReason)').length - 1, 2)
  assert.ok(settingsTab.indexOf('dshMarketRestartBanner') < settingsTab.indexOf('className="dshMarketViewBar"'))
  // 按钮只在宿主确实能重启时出现，并且调的是新端点。
  assert.match(settingsTab, /\{canRestart && \(/u)
  assert.match(settingsTab, /const canRestart = state\?\.desktopActions\.restart === true/u)
  assert.match(settingsTab, /onClick=\{\(\) => \{ void restartNow\(\) \}\}/u)
  assert.match(settingsTab, /await requestMarketRestart\(request\.signal\)/u)
  // 文案里说得出是哪个插件、为什么要重启。
  for (const key of ['restartBannerTitle', 'restartBannerShared', 'restartBannerGeneric', 'restartBannerPlugins', 'restartNow']) {
    assert.ok(locales.includes(`${key}: "`), `缺少文案 ${key}`)
  }
})

test('the state endpoint carries the pending list and whether this Host can restart', () => {
  const { types, routes, index, settingsTab } = addMarketRestartPrompt(input())
  assert.match(types, /readonly restart\?: boolean/u)
  assert.match(types, /readonly pendingRestarts\?: readonly MarketPendingRestart\[\]/u)
  assert.match(routes, /restart: typeof desktopActions\?\.requestRestart === 'function',/u)
  assert.match(routes, /pendingRestarts: installProvider\?\.get\(\)\?\.listPendingRestarts\(\) \?\? \[\],/u)
  // 市场自己声明的桌面能力要认这个方法，否则宿主提供了也读不出来。
  assert.match(index, /interface DesktopActionsCapability \{\n {2}openTerminal\?\(\): void\n {2}requestRestart\?\(\): Promise<void>\n\}/u)
  // 每次挂载按宿主报的清单起步：换标签页回来横幅还在。
  assert.match(settingsTab, /setState\(next\)\n {6}setRestartPending\(next\.pendingRestarts \?\? \[\]\)/u)
  // 来源变更后重建的状态对象不能漏字段，漏了横幅会在改完来源之后消失。
  assert.match(settingsTab, /pendingRestarts: state\?\.pendingRestarts \?\? \[\],/u)
})

test('re-applying the overlay fails on its own output', () => {
  const applied = addMarketRestartPrompt(input())
  assert.throws(() => addMarketRestartPrompt(applied), AnchorError)
})
