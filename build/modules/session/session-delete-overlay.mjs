/* ============================================================
 * 产品覆盖：永久删除会话（T0069）
 * ============================================================
 * 会话菜单（行尾「…」，右键同样打开）加「删除」，确认后永久删除会话目录。
 * 删除步骤在 assets/session-delete-core.ts；这里只有把它接进 staging 的纯转换函数：
 *   - Desktop 宿主入口注册私有删除路由，复用设置路由的回环 + 精确 Origin 校验；
 *   - Desktop 客户端入口注册菜单项与确认框；
 *   - dsh-agent 保留 create/resume 返回的 AgentHandle，按会话释放（上游把它丢了，
 *     会话一旦打开，Agent、写句柄和 lease 就一直留到进程退出）；
 *   - ui-workspace 会话行右键打开同一个「…」菜单，菜单出现在光标处。
 * ============================================================ */
import { insertAfter, insertBefore, replaceOnce, replacePatternOnce, requireOnce } from '../../pipeline/anchors.mjs'

/* --------------------------- Desktop 宿主 --------------------------- */

const ROUTE_HELPERS_MARKER = '// TokensCowork: the private session-delete route shares this guard.'

/**
 * 在 Desktop 设置路由文件末尾导出两个辅助函数，让删除路由与「删除 Profile」走同一套校验。
 * @param route - staging 中 src/desktop-settings-route.ts（LF）。
 * @returns 追加导出后的源码。
 */
export function exportPrivateRouteHelpers(route) {
  for (const anchor of [
    'function isSameOriginLoopbackRequest(',
    'async function parsePostBody(',
    'function finishJson(',
    "const INVALID_BODY = Symbol('invalid body')",
    "import type { IncomingMessage, ServerResponse } from 'node:http'",
  ]) requireOnce(route, anchor, 'desktop-settings-route.ts')
  if (route.includes(ROUTE_HELPERS_MARKER)) throw new Error('desktop-settings-route.ts 已含删除路由辅助函数，请复查覆盖')
  return `${route.trimEnd()}

${ROUTE_HELPERS_MARKER}
/** Read one mutating private-route JSON body; answers the refusal itself and returns undefined. */
export async function readPrivateDesktopJson(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
): Promise<unknown> {
  if (req.method !== 'POST') {
    finishJson(res, 405, error('method not allowed'), 'POST')
    return undefined
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    finishJson(res, 403, error('forbidden'))
    return undefined
  }
  const value = await parsePostBody(req, res)
  return value === INVALID_BODY ? undefined : value
}

/** Answer one private-route request with an uncached JSON body. */
export function finishPrivateDesktopJson(res: ServerResponse, statusCode: number, value: object): void {
  finishJson(res, statusCode, value)
}
`
}

/**
 * 在 Desktop 宿主入口导入并注册删除路由；位置在私有设置路由之后、启动报告路由之前，
 * 与它们同样只在 desktopRuntime 存在时执行。
 * @param index - staging 中 src/index.ts（LF）。
 * @returns 接入删除路由后的源码。
 */
export function wireSessionDeleteHost(index) {
  if (index.includes('installSessionDelete')) throw new Error('src/index.ts 已接入删除路由，请复查覆盖')
  requireOnce(index, 'function rejectDesktopRequest(', 'src/index.ts')
  requireOnce(index, 'const rendererOrigin = `http://127.0.0.1:${String(webServerPort)}`', 'src/index.ts')
  let next = insertAfter(index,
    "import { desktopBootRecoveryInjections } from './desktop-boot-recovery.ts'\n",
    "import { installSessionDelete } from './tokens-session-delete.ts'\n",
    'src/index.ts')
  next = insertBefore(next,
    "  ctx.effect(\n    () => ctx.webServer.register({\n      kind: 'exact',\n      path: RENDERER_BOOT_REPORT_PATH,",
    '  // TokensCowork: private route that permanently deletes one Session (T0069).\n'
    + '  installSessionDelete(ctx, rendererOrigin, rejectDesktopRequest)\n',
    'src/index.ts')
  return next
}

/* -------------------------- Desktop 客户端 -------------------------- */

/**
 * 在 Desktop 客户端入口注册「删除」菜单项与确认框；三种窗口模式都注册。
 * @param clientIndex - staging 中 src/client/index.ts（LF）。
 * @returns 接入后的源码。
 */
export function wireSessionDeleteClient(clientIndex) {
  if (clientIndex.includes('applySessionDelete')) throw new Error('src/client/index.ts 已接入删除菜单项，请复查覆盖')
  let next = insertAfter(clientIndex,
    "import { applyDesktopSettings } from './desktop-settings.ts'\n",
    "import { applySessionDelete } from './tokens-session-delete.tsx'\n",
    'src/client/index.ts')
  next = insertAfter(next,
    '  registerPluginControls(ctx)\n',
    '  // TokensCowork: the Session menu\'s permanent Delete row (T0069).\n  applySessionDelete(ctx)\n',
    'src/client/index.ts')
  return next
}

/* ---------------------------- dsh-agent ---------------------------- */

const AGENT_MARKER = '/* TokensCowork: retained Agent handles (session.agent-handles). */'

/**
 * 注入 dsh-agent 编译产物的运行时片段。导出成字符串，好让真实宿主冒烟脚本
 * 跑的是同一段代码。只认 handle.agent 仍是注册表当前 Agent 的那一份 handle。
 */
export const AGENT_HANDLES_RUNTIME = `${AGENT_MARKER}
const TOKENS_AGENT_HANDLES = new Map();
function tokensTrackAgentHandle(registry, handle) {
	const id = handle?.agent?.id;
	if (id === void 0) return handle;
	for (const [key, held] of TOKENS_AGENT_HANDLES) if (registry.get(key) !== held.agent) TOKENS_AGENT_HANDLES.delete(key);
	TOKENS_AGENT_HANDLES.set(id, handle);
	return handle;
}
async function tokensReleaseAgentHandle(registry, id) {
	const live = registry.get(id);
	const held = TOKENS_AGENT_HANDLES.get(id);
	if (held === void 0 || held.agent !== live) {
		TOKENS_AGENT_HANDLES.delete(id);
		return live === void 0 ? "absent" : "unowned";
	}
	TOKENS_AGENT_HANDLES.delete(id);
	await held.dispose();
	return "released";
}
`

/**
 * AgentRegistry.create / resume 把返回的 handle 记下来，并加 tokensReleaseAgent(id)：
 * 用 handle.dispose() 停掉循环、等它空闲、关闭写句柄（释放 lease）、退出注册表。
 * 必须可重复执行。
 * @param lib - @deepseek-ai/dsh-agent/lib/index.js。
 * @returns 加工后的源码。
 */
export function retainAgentHandles(lib) {
  if (lib.includes(AGENT_MARKER)) return lib
  let next = insertBefore(lib, 'var AgentRegistry = class extends Service {', `${AGENT_HANDLES_RUNTIME}\n`, 'dsh-agent')
  next = replaceOnce(next,
    '\t\treturn Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);',
    '\t\treturn tokensTrackAgentHandle(this, await Reflect.apply(target.createAgent, receiver, [ownerCtx, options]));',
    'dsh-agent create')
  next = replaceOnce(next,
    '\t\treturn Reflect.apply(target.resume, receiver, [ownerCtx, options]);',
    '\t\treturn tokensTrackAgentHandle(this, await Reflect.apply(target.resume, receiver, [ownerCtx, options]));',
    'dsh-agent resume')
  next = insertBefore(next, '\tasync create(options) {',
    '\t/** TokensCowork: dispose the live Agent through the handle its create/resume returned. */\n'
    + '\ttokensReleaseAgent(id) {\n\t\treturn tokensReleaseAgentHandle(this, id);\n\t}\n',
    'dsh-agent create')
  return next
}

/* ------------------------- ui-workspace 右键 ------------------------- */

const ROW_MARKER = '/* TokensCowork: right-click opens the Session menu at the pointer. */'

/**
 * 会话行加 onContextMenu：阻止浏览器菜单，在光标处打开同一个「…」菜单。
 * 新建的空白会话行没有菜单，右键保持浏览器默认。项目行不动。
 * 必须可重复执行。
 * @param client - @deepseek-ai/dsh-client-ui-workspace/lib/client.js。
 * @returns 加工后的源码。
 */
export function openSessionMenuOnContextMenu(client) {
  if (client.includes(ROW_MARKER)) return client
  const start = client.indexOf('function SessionNodeItem({')
  requireOnce(client, 'function SessionNodeItem({', 'ui-workspace SessionNodeItem')
  const rest = client.slice(start + 1)
  const end = start + 1 + rest.search(/\n\t*function [A-Za-z]/u)
  if (end <= start) throw new Error('ui-workspace: 找不到 SessionNodeItem 的结尾')
  let row = client.slice(start, end)
  row = insertAfter(row,
    'const [menuOpen, setMenuOpen] = (0, react.useState)(false);',
    ` ${ROW_MARKER} const [tokensMenuPoint, setTokensMenuPoint] = (0, react.useState)(null);`,
    'ui-workspace SessionNodeItem state')
  row = replacePatternOnce(row,
    /onClick: \(\) => \{\s*onOpen\(node\.id\);\s*\},/u,
    match => `${match}\n\t\t\t\t\tonContextMenu: row.blank ? void 0 : (e) => {\n\t\t\t\t\t\te.preventDefault();\n\t\t\t\t\t\tsetTokensMenuPoint(new DOMRect(e.clientX, e.clientY, 0, 0));\n\t\t\t\t\t\tsetMenuOpen(true);\n\t\t\t\t\t},`,
    'ui-workspace SessionNodeItem row click')
  row = replacePatternOnce(row,
    /portal: true,(\s*)closeOnPointerLeave: true,/u,
    (match, space) => `${match}${space}getAnchorRect: tokensMenuPoint === null ? void 0 : () => tokensMenuPoint,`,
    'ui-workspace SessionNodeItem menu')
  row = replaceOnce(row,
    'setMenuOpen((v) => !v);',
    'setTokensMenuPoint(null);\n\t\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);',
    'ui-workspace SessionNodeItem trigger')
  return client.slice(0, start) + row + client.slice(end)
}
