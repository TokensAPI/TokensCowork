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
