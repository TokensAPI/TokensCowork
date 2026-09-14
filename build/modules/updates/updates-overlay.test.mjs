import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { alignProductUpdateCommand, disableUpstreamUpdates, verifyProductUpdateMenu, verifyDisabledUpdateMenu, configureProductUpdates } from './updates-overlay.mjs'

const read = path => readFileSync(new URL(`../../../desktop/dsh-plugin-desktop/${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
test('product and clean menu predicates accept only their intended tray entries', () => {
  const source = read('scripts/verify-profile-boot.mjs')
  const start = source.indexOf("  if (!trayItems.some(item => item.label() === 'Check for Updates…'))")
  assert.ok(start >= 0)
  const original = source.slice(start, source.indexOf('\n  }', start) + 4)
  const product = verifyProductUpdateMenu(original)
  const clean = verifyDisabledUpdateMenu(original)
  const run = (code, labels, id = 'check-for-updates') => runInNewContext(code, { trayItems: labels.map(value => ({ id, label: () => value })) })
  run(product, ['Check Updates…'])
  assert.throws(() => run(product, ['Check Updates…'], 'wrong-id'))
  run(clean, [])
  assert.throws(() => run(product, []))
  assert.throws(() => run(product, ['Check for Updates…', 'Check Updates…']))
  assert.throws(() => run(clean, ['Check Updates…']))
})

const pluginSource = readFileSync(new URL('../../../plugins/tokens_DshVersionUpdates_code/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
function registerCommand(source, invoke) {
  const start = source.indexOf('    const registration = ctx.desktopRuntime.registerTrayItem({')
  const end = source.indexOf('\n    refreshTray = registration.refresh', start)
  assert.ok(start >= 0 && end > start, 'pinned plugin registration contract')
  let command
  runInNewContext(source.slice(start, end), {
    ctx: { desktopRuntime: { registerTrayItem(item) { command = item; return {} } } },
    downloadingVersion: undefined, availableVersion: undefined, checking: false,
    productName: 'TokensCowork', runManualCheck: invoke,
  })
  return command
}

test('actual compatibility menu routes to the product plugin manual check', async () => {
  const source = read('src/electron-runtime.ts')
  const start = source.indexOf('          checkForUpdates: async () => {')
  const end = source.indexOf('\n          },', start)
  assert.ok(start >= 0 && end > start, 'pinned Desktop update handler contract')
  const makeActions = new Function(`return ({${source.slice(start, end)}\n}})`)
  const route = read('src/compatibility-shell.ts').match(/case 'check-for-updates': return this\.actions\.checkForUpdates\(\)/u)?.[0]
  assert.ok(route, 'pinned compatibility menu must route through the action')
  const dispatch = new Function('command', `switch (command) { ${route} }`)
  let checks = 0
  const invoke = async () => { checks++ }
  const run = item => dispatch.call({ actions: makeActions.call({ trayItems: new Map([['product', item]]) }) }, 'check-for-updates')
  await assert.rejects(run(registerCommand(pluginSource, invoke)), /update check is unavailable/)
  const command = registerCommand(alignProductUpdateCommand(pluginSource), invoke)
  assert.equal(command.id, 'check-for-updates')
  assert.equal(command.label(), 'Check Updates…')
  await run(command)
  assert.equal(checks, 1)
  await command.invoke()
  assert.equal(checks, 2, 'tray and top menu use the same handler')
  await assert.rejects(run({ ...command, enabled: () => false }), /unavailable/)
  await assert.rejects(run({ ...command, invoke: async () => { throw new Error('request failed') } }), /request failed/)
})

test('update command adaptation is idempotent and rejects changed registrations', () => {
  const patched = alignProductUpdateCommand(pluginSource)
  assert.equal(alignProductUpdateCommand(patched), patched)
  const windows = patched.replaceAll('\n', '\r\n')
  assert.equal(alignProductUpdateCommand(windows), windows)
  assert.throws(() => alignProductUpdateCommand(pluginSource + pluginSource), /registration changed/)
  assert.throws(() => alignProductUpdateCommand(pluginSource.replace("group: 'status'", "group: 'other'")), /anchor changed/)
  assert.throws(() => alignProductUpdateCommand(patched.replace("id: 'check-for-updates'", "id: 'other'")), /anchor changed/)
  const pipeline = readFileSync(new URL('../../pipeline/staging-plugins-compile.mjs', import.meta.url), 'utf8')
  assert.ok(pipeline.includes("plugin.id === 'tokens-version-updates' && plugin.enabledByDefault === true"))
  assert.ok(pipeline.includes('const patched = alignProductUpdateCommand(source)'))
})
test('official updates stay disabled and product release configuration remains explicit', () => {
  assert.match(disableUpstreamUpdates(read('cordis.patch.yml')), /- id: desktop-updates\n  disabled: true/)
  const entry = "    - id: tokens-version-updates\r\n      name: '@tokens/dsh-version-updates'"
  assert.match(configureProductUpdates(entry, { name: 'TokensCowork' }, 'TokensAPI', 'TokensCowork'),
    /releaseAPIURL: https:\/\/api.github.com\/repos\/TokensAPI\/TokensCowork\/releases\/latest/)
  assert.throws(() => disableUpstreamUpdates('changed'))
  assert.throws(() => configureProductUpdates('changed', { name: 'TokensCowork' }, 'TokensAPI', 'TokensCowork'))
})
