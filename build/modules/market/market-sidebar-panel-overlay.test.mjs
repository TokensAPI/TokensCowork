import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { MARKET_PANEL_ID, moveMarketToSidebarPanel } from './market-sidebar-panel-overlay.mjs'

// 固定上游的真实文件（desktop 子模块的 dsh-community-market），随 pin 一起变化。
const upstream = path => readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-community-market', path), 'utf8')
const input = () => ({
  clientIndex: upstream('src/client/index.ts'),
  overlay: upstream('src/client/MarketOverlay.tsx'),
  styles: upstream('src/client/styles.ts'),
  locales: upstream('src/client/locales.ts'),
})

test('the market opens from a sidebar row as a main panel instead of the footer launcher', () => {
  const out = moveMarketToSidebarPanel(input())
  assert.doesNotMatch(out.clientIndex, /sidebar\.footer\.action|MarketLauncher/)
  // The row and the panel share one id: the sidebar selects the main panel by it.
  assert.match(out.clientIndex, new RegExp(`const MARKET_PANEL_ID = '${MARKET_PANEL_ID}' as MainPanelId`))
  assert.match(out.clientIndex, /name: 'main',\n {4}key: MARKET_PANEL_ID,[\s\S]*?\}, MarketPage\)\)/)
  assert.match(out.clientIndex, /name: 'sidebar\.panellist',\n {4}id: MARKET_PANEL_ID,\n {4}order: 0,\n {4}label: \(\) => ctx\.locale\.bind\(NS\)\('sidebarEntry'\),[\s\S]*?\}, MarketPanelIcon\)\)/)
  // The overlay and the Settings tab stay registered.
  assert.match(out.clientIndex, /name: 'shell\.overlay'/)
  assert.match(out.clientIndex, /name: 'settings\.plugins\.tab'/)
  // The page is the old overlay's title over the same surface, without the dialog or close button.
  assert.match(out.overlay, /export function MarketPage\([\s\S]*?<h1>\{t\('title'\)\}<\/h1>[\s\S]*?<MarketSurface readLocale=\{readLocale\} showHeader=\{false\} t=\{t\} \/>/)
  assert.match(out.overlay, /export function MarketPanelIcon\(\{ size \}[\s\S]*?<IconPluginPinwheelOutlineRegular size=\{size\} \/>/)
  assert.match(out.styles, /\.dshMarketPage \{[^}]*overflow-y: auto;/)
  assert.match(out.locales, /tab: '插件市场',\n {2}sidebarEntry: '插件',/)
  assert.match(out.locales, /tab: 'Plugin Market',\n {2}sidebarEntry: 'Plugins',/)
  assert.deepEqual(moveMarketToSidebarPanel(out), out, '幂等')
})

test('a drifted upstream registration fails the build instead of leaving the footer launcher', () => {
  const drifted = input()
  drifted.clientIndex = drifted.clientIndex.replace("    order: 10,\n    label: () => ctx.locale.bind(NS)('tab'),", "    order: 12,\n    label: () => ctx.locale.bind(NS)('tab'),")
  assert.throws(() => moveMarketToSidebarPanel(drifted), AnchorError)
})

test('the official Plugins page row stays hidden so the sidebar has one Plugins row', async () => {
  const { default: overlays } = await import('./overlays.mjs')
  const ids = overlays.map(item => item.id)
  assert.ok(ids.includes('market.plugin-page-sidebar-entry'))
  assert.ok(ids.includes('market.sidebar-panel'))
  assert.ok(!ids.includes('market.plugins-page-discover-tab'), 'the Plugins page gets no extra Discover tab')
})
