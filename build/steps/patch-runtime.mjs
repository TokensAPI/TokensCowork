/* ============================================================
 * 安装后运行时补丁:agent-presets 预设健康检查的 asar 感知
 * ============================================================
 * 上游打包把普通运行时模块收进 app.asar,并由注册的模块解析钩子提供
 * 导入;afterPack 门禁同时禁止这些模块再以真实文件解包。但 agent-presets
 * 的 packageInstalled 用裸 existsSync 向上遍历 node_modules 判定预设行
 * 可解析性——裸 fs 看不进 asar,232 个运行时包全部误判缺失,预设无法
 * 挂载,新会话/项目选择/续聊全部失效(v0.4.0/v0.4.1 真机回归)。
 *
 * 上游(deepseek-harness origin/master)尚未修复。在 yarn install 之后、
 * 打包之前,把 staging 里已安装的编译产物补成:文件遍历失败时退回
 * createRequire(base).resolve(name)——它经过同一套解析钩子,在打包环境
 * 里能看到 asar 内模块,在开发环境里与文件遍历等价。只解析不执行,
 * 保持"判定不加载"的原语义。
 *
 * verify-package 以补丁标记验收("packaged-runtime health parity"),
 * 补丁缺失则安装包构建失败;上游改动该函数时本脚本锚点失配即报错,
 * 中断打包待人工复查。
 * ============================================================ */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const stage = resolve(root, '.build', 'desktop')
const MARKER = 'packaged-runtime health parity'

const ANCHOR = `function packageInstalled(name, base) {
	const pkg = name.split("/").slice(0, name.startsWith("@") ? 2 : 1).join("/");
	let dir = fileURLToPath(base);
	for (;;) {
		if (existsSync(join(dir, "node_modules", pkg, "package.json"))) return true;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}`

const REPLACEMENT = `function packageInstalled(name, base) {
	const pkg = name.split("/").slice(0, name.startsWith("@") ? 2 : 1).join("/");
	let dir = fileURLToPath(base);
	for (;;) {
		if (existsSync(join(dir, "node_modules", pkg, "package.json"))) return true;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// TokensCowork 产品补丁(packaged-runtime health parity):打包环境的普通
	// 运行时模块在 app.asar 内,裸 fs 不可见,但注册的解析钩子可见。宣告一行
	// 缺失之前先问解析器;只解析不执行,保持原有"判定不加载"语义。
	try {
		tokensProductCreateRequire(base).resolve(name);
		return true;
	} catch {
		return false;
	}
}`

const IMPORT_ANCHOR = `import { isBuiltin } from "node:module";`
const IMPORT_REPLACEMENT = `import { isBuiltin, createRequire as tokensProductCreateRequire } from "node:module";`

// yarn 可能把包装在 workspace 本地,也可能提升到 staging 根;两处都补,
// 至少一处成功。electron-builder 打包 dsh-plugin-desktop 时按 Node 解析
// 规则收集依赖,补丁随已安装文件进入 asar。
const candidates = [
  resolve(stage, 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js'),
  resolve(stage, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js'),
]

let patched = 0
for (const path of candidates) {
  if (!existsSync(path)) continue
  const source = readFileSync(path, 'utf8')
  if (source.includes(MARKER)) { patched += 1; continue }
  if (!source.includes(ANCHOR) || !source.includes(IMPORT_ANCHOR)) {
    throw new Error(`patch-runtime: 未找到 agent-presets 健康检查锚点(${path});上游实现已变化,请复查 asar 感知补丁是否仍然需要`)
  }
  writeFileSync(path, source.replace(IMPORT_ANCHOR, IMPORT_REPLACEMENT).replace(ANCHOR, REPLACEMENT))
  patched += 1
  process.stdout.write(`patch-runtime: asar-aware preset discovery -> ${path}\n`)
}
if (patched === 0) {
  throw new Error('patch-runtime: 没有找到任何已安装的 agent-presets 副本;先运行 yarn install')
}

/* ============================================================
 * DSH 0.1.3-alpha.1 Conversation 公共输入组件
 * ============================================================
 * 该版本的 InputBar 已经拥有稳定的 card 样式和 data-composer-card 契约，
 * 但没有导出可供外部会话源复用的表面组件。产品 staging 在已安装产物中
 * 提取 ComposerSurface，并让原生 InputBar 自身也通过它渲染。随后公开
 * ExternalComposer：它使用 InputBar 的 Lexical contenteditable、原生键盘
 * 规则与 CSS module，并把 value/onChange/onSubmit 交给外部会话适配器。
 * ============================================================ */
const COMPOSER_MARKER = 'TokensCowork shared composer surface'
const COMPOSER_DEFINITION_ANCHOR = `\t\t};
\t\t//#endregion
\t\t//#region lib/types/client/skeleton/InputBar.js`
const COMPOSER_DEFINITION = `\t\t};
\t\t/** TokensCowork shared composer surface: the public, target-neutral InputBar card. */
\t\tconst ComposerSurface = react.forwardRef(function ComposerSurface({ workspaceTrigger = false, className, ...props }, ref) {
\t\t\treturn (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t...props,
\t\t\t\tref,
\t\t\t\tclassName: clsx(InputBar_module_css_default.card, workspaceTrigger && InputBar_module_css_default.cardWorkspaceTrigger, className),
\t\t\t\t"data-composer-card": true
\t\t\t});
\t\t});
\t\t//#endregion
\t\t//#region lib/types/client/skeleton/InputBar.js`
const COMPOSER_INPUT_ANCHOR = `(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\tref: cardRef,
\t\t\t\t\t\tclassName: clsx(InputBar_module_css_default.card, workspaceTrigger && InputBar_module_css_default.cardWorkspaceTrigger),
\t\t\t\t\t\t"data-composer-card": true,`
const COMPOSER_INPUT_REPLACEMENT = `(0, react_jsx_runtime.jsxs)(ComposerSurface, {
\t\t\t\t\t\tref: cardRef,
\t\t\t\t\t\tworkspaceTrigger,`
const COMPOSER_EXPORT_ANCHOR = `\t\texports.Config = Config;`
const COMPOSER_EXPORT_REPLACEMENT = `\t\texports.ComposerSurface = ComposerSurface;
\t\texports.Config = Config;`
const COMPOSER_TYPES_ANCHOR = `declare module '@deepseek-ai/cordis' {`
const COMPOSER_TYPES_REPLACEMENT = `/** Public InputBar card surface for external conversation adapters. */
export type ComposerSurfaceProps = import('react').HTMLAttributes<HTMLDivElement> & {
    workspaceTrigger?: boolean;
};
export declare const ComposerSurface: import('react').ForwardRefExoticComponent<ComposerSurfaceProps & import('react').RefAttributes<HTMLDivElement>>;
declare module '@deepseek-ai/cordis' {`

const EXTERNAL_COMPOSER_MARKER = 'TokensCowork native external composer'
const externalComposerRuntime = readFileSync(resolve(import.meta.dirname, '..', 'assets', 'runtime', 'external-composer-runtime.txt'), 'utf8').trimEnd()
const EXTERNAL_COMPOSER_ANCHOR = `\t\t});
\t\t//#endregion
\t\t//#region lib/types/client/skeleton/InputBar.js`
const EXTERNAL_COMPOSER_REPLACEMENT = `\t\t});
${externalComposerRuntime}
\t\t//#endregion
\t\t//#region lib/types/client/skeleton/InputBar.js`
const EXTERNAL_COMPOSER_EXPORT = `\t\texports.ExternalComposer = ExternalComposer;
\t\texports.Config = Config;`
const EXTERNAL_COMPOSER_TYPES_ANCHOR = `declare module '@deepseek-ai/cordis' {`
const EXTERNAL_COMPOSER_TYPES_REPLACEMENT = `/** DSH Lexical composer for a target-neutral external conversation adapter. */
export interface ExternalComposerProps {
    value: string;
    onChange(value: string): void;
    onSubmit(): void;
    onStop?(): void;
    running?: boolean;
    disabled?: boolean;
    busy?: boolean;
    placeholder?: string;
    ariaLabel?: string;
    modelControl?: import('react').ReactNode;
    className?: string;
}
export declare const ExternalComposer: import('react').MemoExoticComponent<(props: ExternalComposerProps) => import('react').ReactNode>;
declare module '@deepseek-ai/cordis' {`

const conversationRoots = [
  resolve(stage, 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation'),
  resolve(stage, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation'),
]
let conversationPatched = 0
for (const packageRoot of conversationRoots) {
  const clientPath = resolve(packageRoot, 'lib', 'client.js')
  if (!existsSync(clientPath)) continue
  let client = readFileSync(clientPath, 'utf8')
  const typesPath = resolve(packageRoot, 'lib', 'types', 'client', 'index.d.ts')
  let types = readFileSync(typesPath, 'utf8')
  if (!client.includes(COMPOSER_MARKER)) {
    for (const [anchor, replacement] of [
      [COMPOSER_DEFINITION_ANCHOR, COMPOSER_DEFINITION],
      [COMPOSER_INPUT_ANCHOR, COMPOSER_INPUT_REPLACEMENT],
      [COMPOSER_EXPORT_ANCHOR, COMPOSER_EXPORT_REPLACEMENT],
    ]) {
      if (!client.includes(anchor)) {
        throw new Error(`patch-runtime: 未找到 Conversation composer surface 锚点(${clientPath})`)
      }
      client = client.replace(anchor, replacement)
    }
    if (!types.includes(COMPOSER_TYPES_ANCHOR)) {
      throw new Error(`patch-runtime: 未找到 Conversation composer 类型锚点(${typesPath})`)
    }
    types = types.replace(COMPOSER_TYPES_ANCHOR, COMPOSER_TYPES_REPLACEMENT)
  }
  if (!client.includes(EXTERNAL_COMPOSER_MARKER)) {
    if (!client.includes(EXTERNAL_COMPOSER_ANCHOR) || !client.includes(COMPOSER_EXPORT_ANCHOR)) {
      throw new Error(`patch-runtime: 未找到 Conversation external composer 锚点(${clientPath})`)
    }
    client = client
      .replace(EXTERNAL_COMPOSER_ANCHOR, EXTERNAL_COMPOSER_REPLACEMENT)
      .replace(COMPOSER_EXPORT_ANCHOR, EXTERNAL_COMPOSER_EXPORT)
    if (!types.includes(EXTERNAL_COMPOSER_TYPES_ANCHOR)) {
      throw new Error(`patch-runtime: 未找到 ExternalComposer 类型锚点(${typesPath})`)
    }
    types = types.replace(EXTERNAL_COMPOSER_TYPES_ANCHOR, EXTERNAL_COMPOSER_TYPES_REPLACEMENT)
  }
  writeFileSync(clientPath, client)
  writeFileSync(typesPath, types)
  conversationPatched += 1
  process.stdout.write(`patch-runtime: shared ComposerSurface -> ${clientPath}\n`)
}
if (conversationPatched === 0) {
  throw new Error('patch-runtime: 没有找到 DSH Conversation 运行时;先运行 yarn install')
}
