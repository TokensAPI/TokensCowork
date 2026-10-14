import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { removePluginPageInstall } from './market-plugin-page-overlay.mjs'

// Verbatim from @deepseek-ai/dsh-client-ui-plugin-manager 0.2.0-rc.2 lib/client.js (the DSH 0.2 pin):
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
							}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								className: PluginManagerPage_module_css_default.addButton,
								icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 13 }),
								disabled: !loaded,
								onClick: props.openInstall,
								children: t(state.install.requestId === void 0 ? "addPlugin" : "installViewTask")
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
const source = `function toolbar(props, state, loaded, refreshing, t) { return {${TOOLBAR}} }
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

test('the original page renders refresh and an add button wired to openInstall', () => {
  const { toolbar } = load(source)
  const children = toolbar(props, { install: { requestId: void 0 } }, true, false, key => key).children
  assert.equal(children.length, 2)
  assert.equal(children[1].props.onClick, props.openInstall)
})

test('the plugin page keeps refresh but no longer offers to add a plugin', () => {
  const { toolbar, Store } = load(removePluginPageInstall(source))
  const children = toolbar(props, { install: { requestId: void 0 } }, true, false, key => key).children
  assert.equal(children.length, 1)
  assert.equal(children[0].type, 'Tooltip')
  assert.equal(children[0].props.children.props.onClick, props.refresh)
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
  assert.throws(() => removePluginPageInstall(source.replace('className: PluginManagerPage_module_css_default.addButton,', '')), AnchorError)
  assert.throws(() => removePluginPageInstall(source.replace('"plugin_add_button_click"', '"plugin_add_click"')), AnchorError)
})

test('the registered overlay skips a staging without the plugin page package and runs when it is installed', async () => {
  const { default: overlays } = await import('./overlays.mjs')
  const overlay = overlays.find(item => item.id === 'market.plugin-page-install')
  assert.equal(overlay.phase, 'installed')
  assert.equal(overlay.when({ files: { has: () => false } }), false)
  assert.equal(overlay.when({ files: { has: path => path === overlay.files.client } }), true)
})
