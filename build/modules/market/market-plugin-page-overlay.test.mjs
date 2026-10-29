import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { hidePluginPageSidebarEntry, removePluginPageInstall } from './market-plugin-page-overlay.mjs'

// Verbatim from @deepseek-ai/dsh-client-ui-plugin-manager 0.2.1-rc.2 lib/client.js (the DSH pin):
// the plugin page toolbar children and the store's openInstall. Refresh this fixture when the pin moves.
const TOOLBAR = `
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t("refresh"),
								delayMs: 500,
								focusDelayMs: 500,
								side: "bottom",
								portal: true,
								disabled: !loaded || refreshing,
								children: (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: PluginManagerPage_module_css_default.iconButton,
									"aria-label": t("refresh"),
									"aria-busy": refreshing,
									disabled: !loaded || refreshing,
									onClick: props.refresh,
									children: (0, react_jsx_runtime.jsx)("span", {
										className: PluginManagerPage_module_css_default.iconWrap,
										"aria-hidden": "true",
										children: refreshing ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
											state: "ongoing",
											size: 18
										}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, {})
									})
								})
							}), state.install.requestId === void 0 ? (0, react_jsx_runtime.jsx)(AddPluginMenu, {
								t,
								disabled: !loaded,
								openInstall: props.openInstall,
								renderSlot
							}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								className: PluginManagerPage_module_css_default.addButton,
								icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 13 }),
								disabled: !loaded,
								onClick: props.openInstall,
								children: t("installViewTask")
							})]`
const OPEN_INSTALL = `
					openInstall: () => {
						this.ctx.get("productAnalytics")?.track("plugin_add_button_click", {});
						if (this.getSnapshot().install.requestId === void 0) {
							this.patch({ install: {
								...IDLE_INSTALL,
								open: true,
								registry: this.registryMemory.getSnapshot() ?? OFFICIAL_REGISTRY
							} });
							const read = { choice: this.getSnapshot().install.registry };
							this.registryRead = read;
							read.done = this.readRegistries(read).finally(() => {
								delete read.done;
							});
						} else this.patchInstall({ open: true });
						this.reconcileInstall();
					},`
const source = `function AddPluginMenu(props) { return { type: "AddPluginMenu", props } }
function toolbar(props, state, loaded, refreshing, t, renderSlot) { return {${TOOLBAR}} }
class Store {
  constructor(ctx) { this.ctx = ctx; this.calls = []; this.registryMemory = { getSnapshot: () => null } }
  getSnapshot() { return { install: { requestId: void 0 } } }
  patch(value) { this.calls.push(['patch', value]) }
  patchInstall(value) { this.calls.push(['patchInstall', value]) }
  readRegistries() { this.calls.push(['readRegistries']); return Promise.resolve() }
  reconcileInstall() { this.calls.push(['reconcileInstall']) }
  api() { return {${OPEN_INSTALL}} }
}`

// Runs the transformed snippet with a JSX runtime that records the element tree.
function load(code) {
  const jsx = (type, props) => ({ type, props })
  const primitives = new Proxy({}, { get: (_, name) => name })
  const css = new Proxy({}, { get: (_, name) => name })
  return new Function('react_jsx_runtime', '_deepseek_ai_dsh_client_ui_primitives', 'PluginManagerPage_module_css_default', 'IDLE_INSTALL', 'OFFICIAL_REGISTRY',
    `${code}; return { toolbar, Store }`)({ jsx, jsxs: jsx }, primitives, css, {}, 'official')
}
const props = { refresh() {}, openInstall() {} }

const render = (code, requestId) => {
  const { toolbar, Store } = load(code)
  return { children: toolbar(props, { install: { requestId } }, true, false, key => key, () => null).children, Store }
}

test('the original page renders refresh and an add entry wired to openInstall', () => {
  // 没有安装在进行时是“添加插件”下拉组；有安装在进行时是“查看安装任务”。
  const idle = render(source, void 0).children
  assert.equal(idle.length, 2)
  assert.equal(idle[1].props.openInstall, props.openInstall)
  const busy = render(source, 'request-1').children
  assert.equal(busy.length, 2)
  assert.equal(busy[1].props.onClick, props.openInstall)
})

test('the plugin page keeps refresh but no longer offers to add a plugin', () => {
  const patched = removePluginPageInstall(source)
  for (const requestId of [void 0, 'request-1']) {
    const children = render(patched, requestId).children
    assert.equal(children.length, 1)
    assert.equal(children[0].type, 'Tooltip')
    assert.equal(children[0].props.children.props.onClick, props.refresh)
  }
  const { Store } = render(patched, void 0)
  const tracked = []
  const store = new Store({ get: () => ({ track: event => tracked.push(event) }) })
  store.api().openInstall()
  assert.deepEqual(tracked, [])
  assert.deepEqual(store.calls, [], 'openInstall must not open the install dialog')
})

test('the removal is idempotent and refuses a half-patched or drifted upstream', () => {
  const once = removePluginPageInstall(source)
  assert.equal(removePluginPageInstall(once), once)
  const half = once.replace('/* TokensCowork: plugin page install entry removed; install through the plugin market. */ return;', '') + OPEN_INSTALL
  assert.throws(() => removePluginPageInstall(half), /incomplete plugin page install entry removal/)
  assert.throws(() => removePluginPageInstall(source.replace('children: t("installViewTask")', 'children: t("addPlugin")')), AnchorError)
  assert.throws(() => removePluginPageInstall(source.replace('"plugin_add_button_click"', '"plugin_add_click"')), AnchorError)
})

test('the registered overlay skips a staging without the plugin page package and runs when it is installed', async () => {
  const { default: overlays } = await import('./overlays.mjs')
  const overlay = overlays.find(item => item.id === 'market.plugin-page-install')
  assert.equal(overlay.phase, 'installed')
  assert.equal(overlay.when({ files: { has: () => false } }), false)
  assert.equal(overlay.when({ files: { has: path => path === overlay.files.client } }), true)
})

// Verbatim from @deepseek-ai/dsh-client-ui-plugin-manager 0.2.1-rc.2 lib/client.js: the end of
// apply(), where the plugin page registers its sidebar navigation item. Refresh with the pin.
const SIDEBAR_ENTRY = `
			yield () => {
				disposeNavigation();
			};
		});
		ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
			name: "sidebar.panellist",
			id: PANEL_ID,
			order: 0,
			label: () => t("panel"),
			locale: NS
		}, PluginsPanelIcon));
	}
	//#endregion
	exports.NS = NS;
	exports.PANEL_ID = PANEL_ID;
`

test('the sidebar plugins entry is gone while the plugin page itself stays registered', () => {
  const patched = hidePluginPageSidebarEntry(SIDEBAR_ENTRY)
  assert.ok(!patched.includes('sidebar.panellist'), 'the navigation item must not be registered')
  // 只去掉导航项：页面导出、详情跳转（pluginNavigation）与其余代码原样保留。
  assert.ok(patched.includes('exports.PANEL_ID = PANEL_ID;'))
  assert.ok(patched.includes('disposeNavigation();'))
  assert.equal(hidePluginPageSidebarEntry(patched), patched, '幂等')
  assert.throws(() => hidePluginPageSidebarEntry(patched + 'ctx.slots.inject("sidebar.panellist", () => 0)'),
    /incomplete plugin page sidebar entry removal/)
  // 上游改了注册形状就必须报错，而不是悄悄把入口留在侧栏。
  assert.throws(() => hidePluginPageSidebarEntry(SIDEBAR_ENTRY.replace('id: PANEL_ID,', 'id: "plugins",')), AnchorError)
})

test('the sidebar entry overlay runs on the same file and condition as the install-entry overlay', async () => {
  const { default: overlays } = await import('./overlays.mjs')
  const entry = overlays.find(item => item.id === 'market.plugin-page-sidebar-entry')
  const install = overlays.find(item => item.id === 'market.plugin-page-install')
  assert.equal(entry.phase, 'installed')
  assert.equal(entry.files.client, install.files.client)
  assert.equal(entry.when({ files: { has: () => false } }), false)
  assert.equal(entry.when({ files: { has: path => path === entry.files.client } }), true)
  // 页面仍可从设置进入，所以去「添加插件」那条覆盖必须仍在。
  assert.ok(install, 'market.plugin-page-install must stay registered')
})
