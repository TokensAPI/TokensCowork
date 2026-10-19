import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import { runOverlays } from './overlay-engine.mjs'
import { productStage } from './paths.mjs'

/* ====================================================================
 * 路径与产品清单
 * 仓库根、staging 目录、desktop 子模块源目录，以及从 product.json
 * 读出的产品清单和默认启用的插件列表。
 * ==================================================================== */

const root = resolve(import.meta.dirname, '..', '..')
const stageRoot = resolve(root, '.build')
const refreshingLock = process.env.PRODUCT_REFRESH_LOCK === '1'
const stage = refreshingLock ? resolve(stageRoot, 'refresh-lock') : productStage(root)
const desktopSource = resolve(root, 'desktop')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const enabledPlugins = manifest.plugins.filter(item => item.enabledByDefault === true)

// 产品运行时由外层固定，安装时仍须通过 Yarn 补丁和 immutable 锁文件校验。
const desktopRuntimeVersion = manifest.desktop.runtimeVersion
if (typeof desktopRuntimeVersion !== 'string' || desktopRuntimeVersion.length === 0) {
  throw new Error('prepare-desktop: desktop runtimeVersion must be a non-empty string')
}

// 体检（overlay-doctor）在临时 staging 中装配：单条覆盖失败时记录并继续。
const audit = process.env.PRODUCT_OVERLAY_AUDIT
const results = []
const overlayPhase = async phase => {
  results.push(...await runOverlays(phase, { stage, product: manifest, audit: audit !== undefined }))
}

/* ====================================================================
 * 工具函数
 * 仅供本脚本使用的通用辅助。产品覆盖登记在各模块的 overlays.mjs，
 * 由 overlay-engine 按阶段执行；本文件只负责复制源码、注入插件与锁文件。
 * ==================================================================== */

function assertGeneratedPath(path) {
  if (path !== stage && !path.startsWith(`${stage}${sep}`)) {
    throw new Error(`prepare-desktop: generated path escaped staging: ${path}`)
  }
}

/*
 * staging 每次都整棵重建，但 node_modules 不是装配产物：它由 stage 里的
 * package.json 与 yarn.lock 决定。跟着一起删只会让紧随其后的
 * `yarn install --immutable` 从零重链整棵依赖树（单次约 5 分钟），
 * 而改一行 overlay 就会触发一次重建。这里清空 staging 时跳过依赖树，
 * 让随后的覆盖拷贝把源码填回来，那次 install 便退化成增量核对。
 * 依赖真的变了也不会失准：yarn 仍按新的 lock 补齐与裁剪。需要纯净重建时
 * 手动删掉 .build/desktop 再跑本脚本即可。
 * 不能改用 rename 把依赖树挪开再挪回：树里有指回 workspace 的符号链接，
 * Windows 上整目录 rename 会 EPERM。
 */

/**
 * 列出 staging 里全部已装好的依赖树（相对 staging 的 POSIX 路径）。
 * workspace 可以嵌套（如 dsh-plugin-desktop/product-plugins/*），深度不固定，
 * 因此整棵扫描；进入 node_modules 后不再下钻，里面的嵌套依赖随其整体保留。
 */
function listStagedModules(base, relativeBase = '') {
  const found = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name
    if (entry.name === 'node_modules') found.push(relativePath)
    else found.push(...listStagedModules(resolve(base, entry.name), relativePath))
  }
  return found
}

/** 清空 staging，但保留其中已装好的 node_modules 及其各级父目录。 */
function clearStageKeepingModules() {
  if (!existsSync(stage)) return
  // 刷新 lock 要的是纯净解析，残留的依赖树一律不留。
  if (refreshingLock) {
    rmSync(stage, { recursive: true, force: true })
    return
  }
  const preserved = new Set(listStagedModules(stage))
  // 依赖树的父目录必须留着当容器，只能逐层进去删同级的其它内容。
  const containers = new Set()
  for (const relativePath of preserved) {
    const parts = relativePath.split('/')
    for (let index = 1; index < parts.length; index += 1) containers.add(parts.slice(0, index).join('/'))
  }
  const clear = (base, relativeBase) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name
      if (preserved.has(relativePath)) continue
      const path = resolve(base, entry.name)
      assertGeneratedPath(path)
      if (containers.has(relativePath)) clear(path, relativePath)
      else rmSync(path, { recursive: true, force: true })
    }
  }
  clear(stage, '')
}

function copySource(source, destination, options = {}) {
  cpSync(source, destination, {
    recursive: true,
    filter: candidate => {
      const name = basename(candidate)
      return name !== '.git' && name !== 'node_modules'
        && (options.includeDist === true || name !== 'dist')
        && !(candidate === resolve(desktopSource, 'deepseek-harness'))
    },
  })
}

function renamePluginPatchPackage(patch, sourcePackage, packageName, pluginId) {
  if (sourcePackage === packageName) return patch
  const candidates = [
    `name: '${sourcePackage}'`,
    `name: "${sourcePackage}"`,
    `name: ${sourcePackage}`,
  ]
  const matches = candidates.filter(candidate => patch.includes(candidate))
  if (matches.length !== 1) {
    throw new Error(`prepare-desktop: ${pluginId} patch package rename is ambiguous`)
  }
  return patch.replace(matches[0], `name: '${packageName}'`)
}

/* ====================================================================
 * 主流程
 * 复制上游源码 → prepare 覆盖 → 注入产品插件 → assemble 覆盖 → 产品锁文件。
 * prepare 覆盖追加的补丁条目必须位于产品插件补丁之前，顺序不能对调。
 * ==================================================================== */

/* ------------------------ 重建 staging 目录 ------------------------- */
mkdirSync(stageRoot, { recursive: true })
assertGeneratedPath(stage)
clearStageKeepingModules()
copySource(desktopSource, stage)

/* ------------------------ 上游副本的产品覆盖 ------------------------ */
await overlayPhase('prepare')

/* ----------------------- 读入注入插件要改的文件 ----------------------- */
const workspacePath = resolve(stage, 'package.json')
const desktopPackagePath = resolve(stage, 'dsh-plugin-desktop', 'package.json')
const desktopPatchPath = resolve(stage, 'dsh-plugin-desktop', 'cordis.patch.yml')
const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
// 归一化 CRLF：Windows CI 的 git autocrlf 会把检出内容转成 CRLF。
let desktopPatch = readFileSync(desktopPatchPath, 'utf8').replaceAll('\r\n', '\n').trimEnd()

/* --------------------------- 注入产品插件 --------------------------- */
for (const plugin of enabledPlugins) {
  const source = plugin.artifact === undefined
    ? resolve(root, plugin.path)
    : resolve(stageRoot, 'product-plugin-artifacts', plugin.id, 'package')
  if (!existsSync(source)) {
    throw new Error(`prepare-desktop: ${plugin.id} release artifact is missing; fetch product plugin artifacts first`)
  }
  // Keep product workspaces below the desktop package so their source-level
  // imports resolve the host's single Cordis/DSH dependency graph.
  const destination = resolve(stage, 'dsh-plugin-desktop', 'product-plugins', plugin.id)
  assertGeneratedPath(destination)
  mkdirSync(resolve(destination, '..'), { recursive: true })
  copySource(source, destination, { includeDist: true })

  // A script-built plugin keeps its declared toolchain only in staging. Pruning
  // removes it after the plugin has produced its runtime files; prebuilt and
  // legacy compiler inputs still avoid installing an unused local toolchain.
  const pluginPackagePath = resolve(destination, 'package.json')
  const pluginPackage = JSON.parse(readFileSync(pluginPackagePath, 'utf8'))
  pluginPackage.name = plugin.package
  if (plugin.runtimeBuild?.script === undefined) {
    delete pluginPackage.devDependencies
    delete pluginPackage.allowScripts
  }

  const workspaceEntry = relative(stage, destination).split(sep).join('/')
  if (!workspace.workspaces.includes(workspaceEntry)) workspace.workspaces.push(workspaceEntry)
  desktopPackage.dependencies[plugin.package] = 'workspace:*'
  for (const [name, version] of Object.entries(plugin.runtimeDependencies ?? {})) {
    desktopPackage.dependencies[name] = version
    if (desktopPackage.devDependencies?.[name] !== undefined) delete desktopPackage.devDependencies[name]
    if (pluginPackage.dependencies?.[name] !== undefined) pluginPackage.dependencies[name] = version
    if (pluginPackage.peerDependencies?.[name] !== undefined) pluginPackage.peerDependencies[name] = version
  }
  writeFileSync(pluginPackagePath, `${JSON.stringify(pluginPackage, undefined, 2)}\n`)

  const pluginPatch = renamePluginPatchPackage(
    readFileSync(resolve(source, plugin.patch), 'utf8').replaceAll('\r\n', '\n').trim(),
    plugin.sourcePackage ?? plugin.package,
    plugin.package,
    plugin.id,
  )
  writeFileSync(resolve(destination, plugin.patch), `${pluginPatch}\n`)
  desktopPatch += `\n\n# Product plugin: ${plugin.id}\n${pluginPatch}`
}

/* --------------------------- 写回注入结果 --------------------------- */
writeFileSync(workspacePath, `${JSON.stringify(workspace, undefined, 2)}\n`)
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(desktopPatchPath, `${desktopPatch}\n`)

/* ------------------------ 插件副本的产品覆盖 ------------------------ */
await overlayPhase('assemble')

/* -------------------------- 安装产品锁文件 -------------------------- */
if (enabledPlugins.length > 0) {
  const productLock = resolve(root, 'build', 'pipeline', 'product.yarn.lock')
  if (existsSync(productLock)) {
    cpSync(productLock, resolve(stage, 'yarn.lock'))
  } else if (process.env.PRODUCT_REFRESH_LOCK !== '1') {
    throw new Error('prepare-desktop: enabled plugins require build/pipeline/product.yarn.lock; run product:refresh-lock')
  }
}

/* --------------------------- 输出装配摘要 --------------------------- */
process.stdout.write(
  `prepare-desktop: staged ${manifest.product.name} ${manifest.product.version} from ${manifest.desktop.commit.slice(0, 10)} with DSH ${desktopRuntimeVersion} and ${enabledPlugins.length} default plugin(s) at ${stage}\n`,
)
if (audit !== undefined) writeFileSync(audit, `${JSON.stringify(results, undefined, 2)}\n`)
