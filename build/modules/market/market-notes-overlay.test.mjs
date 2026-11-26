import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { loadOverlays, runOverlays } from '../../pipeline/overlay-engine.mjs'
import { addMarketPluginNotes, addPluginNotesRuntimeTests, addPluginNotesSettingsTests, PLUGIN_NOTES_ROUTE } from './market-notes-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const origin = JSON.parse(readFileSync(resolve(root, 'market/server/source.config.json'), 'utf8')).origin
const prepare = (await loadOverlays()).filter(overlay => overlay.module === 'market' && overlay.phase === 'prepare')
const at = id => prepare.findIndex(overlay => overlay.id === id)
const files = {
  routes: 'src/host/routes.ts', api: 'src/client/api.ts', types: 'src/api-types.ts',
  settingsTab: 'src/client/MarketSettingsTab.tsx', styles: 'src/client/styles.ts', locales: 'src/client/locales.ts',
}

/** 真实上游市场源码依次跑完排在本覆盖之前的市场覆盖：本覆盖锚定的就是这一刻的内容。 */
async function stageBefore(t, id) {
  const generated = resolve(root, '.build')
  mkdirSync(generated, { recursive: true })
  const stage = mkdtempSync(resolve(generated, 'desktop-market-notes-'))
  t.after(() => {
    assert.ok(relative(generated, stage).startsWith('desktop-market-notes-'))
    rmSync(stage, { recursive: true, force: true })
  })
  cpSync(resolve(root, 'desktop/dsh-community-market'), resolve(stage, 'dsh-community-market'), {
    recursive: true,
    filter: path => !['.git', 'node_modules', 'lib'].includes(basename(path)),
  })
  await runOverlays('prepare', { stage, product, overlays: prepare.slice(0, at(id)).filter(overlay => !overlay.files
    || Object.values(overlay.files).every(file => file.startsWith('dsh-community-market/'))) })
  const read = path => readFileSync(resolve(stage, 'dsh-community-market', path), 'utf8')
  return read
}

test('registered after the overlays it anchors on, with its tests after the docs-link test adaptation', () => {
  assert.ok(at('market.plugin-notes') > at('market.updates'))
  assert.ok(at('market.plugin-notes') > at('market.docs-link'))
  assert.ok(at('market.plugin-notes') > at('market.restart-prompt'))
  assert.ok(at('market.plugin-notes') < at('market.brand-copy'))
  assert.ok(at('market.test-plugin-notes') > at('market.test-docs-link'))
})

test('reads notes through a local Host route on the product origin and renders them as text', async t => {
  const read = await stageBefore(t, 'market.plugin-notes')
  const input = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, read(path)]))
  const output = addMarketPluginNotes(input, origin)
  // 宿主：本地 GET 路由，读的是产品 origin 的 notes 路径，重定向限同源，交回裁剪后的字段。
  assert.match(output.routes, new RegExp(`const ROUTE_PLUGIN_NOTES = '${PLUGIN_NOTES_ROUTE}'`))
  assert.match(output.routes, /new URL\('\/v1\/plugins\/' \+ encodeURIComponent\(itemId\) \+ '\/notes', "https:\/\/[^"]+"\)/)
  assert.match(output.routes, /restrictedHttpClient\.getJson\(target\.href, signal, \{ allowedOrigin: "https:\/\/[^"]+" \}\)/)
  assert.match(output.routes, /answer\(502, \{ error: 'plugin notes unavailable' \}\)/)
  assert.ok(output.routes.indexOf('ROUTE_PLUGIN_NOTES, handler') > output.routes.indexOf('ROUTE_DOCS_LINK, handler'))
  assert.match(output.api, /export async function readMarketPluginNotes\(/)
  assert.match(output.types, /export interface MarketPluginNotesResponse \{/)
  // 渲染层：详情（可折叠）与更新确认框（可滚动），两处都拿到界面语言。
  const tab = output.settingsTab
  assert.match(tab, /<PluginNotes request=\{notesRequest\} locale=\{notesLocale\} collapsible t=\{t\} \/>/)
  assert.match(tab, /request=\{\{ packageName: preview\.packageName, from: preview\.updateFrom, to: preview\.version \}\}/)
  assert.equal(tab.split('notesLocale={readLocale()}').length - 1, 2)
  assert.match(tab, /const notesRequest = inventoryLoading \? undefined : detailNotesRequest\(value, installation\)/)
  // 正文只走 React 文本节点，没有任何 HTML 注入口。
  const component = tab.slice(tab.indexOf('interface PluginNotesRequest'), tab.indexOf('\nfunction OperationFacts('))
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|DOMParser/)
  // 确认按钮与更新按钮不看说明的状态。
  assert.doesNotMatch(tab, /disabled=\{[^}]*notes/i)
  for (const key of ['notesTitle', 'notesTitleRange', 'notesOtherLanguage', 'notesEmpty', 'notesUnavailable', 'notesLoading', 'notesExpand', 'notesCollapse']) {
    assert.equal(output.locales.split(`  ${key}: `).length - 1, 2, key)
  }
  assert.match(output.locales, /notesOtherLanguage: "（仅有英文说明）"/)
  assert.match(output.locales, /notesOtherLanguage: "\(Chinese only\)"/)
  assert.match(output.locales, /notesUnavailable: "暂时读不到更新说明"/)
  assert.match(output.styles, /\.dshMarketNotesScroll \{\n {2}max-height: 240px;\n {2}overflow-y: auto;/)
  // 锚点失配与重复应用都直接失败。
  assert.throws(() => addMarketPluginNotes({ ...input, settingsTab: input.settingsTab.replace('function OperationConfirmModal(', 'function Renamed(') }, origin), /boundary changed|锚点/)
  assert.throws(() => addMarketPluginNotes(output, origin), /already applied/)
  assert.throws(() => addMarketPluginNotes(input, 'http://market.example'), /HTTPS origin required/)
})

test('test adaptations add the api.js stub, one more route, and the product regressions', async t => {
  const read = await stageBefore(t, 'market.test-plugin-notes')
  const settings = addPluginNotesSettingsTests(read('tests/market-settings-tab.spec.tsx'))
  assert.match(settings, /  openMarketDocsLink: vi\.fn\(\),\n  readMarketPluginNotes: vi\.fn\(\),\n/)
  assert.match(settings, /describe\('product plugin release notes'/)
  const runtime = addPluginNotesRuntimeTests(read('tests/market-runtime.spec.ts'))
  assert.match(runtime, /expect\(routeDisposers\)\.toHaveLength\(6\)/)
  assert.match(runtime, new RegExp(`url: '${PLUGIN_NOTES_ROUTE}\\?' \\+ query`))
  assert.throws(() => addPluginNotesRuntimeTests(runtime), /market runtime test/)
})
