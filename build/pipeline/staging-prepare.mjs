import { pinDesktopMarketProvider } from '../modules/market/market-desktop-overlay.mjs'
import { alignFsExtArchitecture } from '../modules/platform/desktop-packaging-overlay.mjs'
import { applyMarketSourceOverlays } from '../modules/market/market-staging-overlay.mjs'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import { productStage } from './paths.mjs'
import { alignRuntimeDependencies, prepareRuntimeVersion } from '../modules/runtime/runtime-version-overlay.mjs'

import { brandDesktopPatch } from '../modules/branding/branding-overlay.mjs'
import { preserveNativeDialogPosition } from '../modules/market/market-dialog-position-overlay.mjs'
import {
  alignCliRuntimeSmokeWithPlatform,
  alignResolverTestFileUrls,
  protectDesktopStderr,
  skipDesktopSetupWizard,
} from '../modules/runtime/desktop-runtime-overlay.mjs'
import { disableUpstreamUpdates, verifyDisabledUpdateMenu, verifyProductUpdateMenu } from '../modules/updates/updates-overlay.mjs'
import { disableUpstreamRepeatReminder } from '../modules/guard/loop-guard-overlay.mjs'
import { addWindowsAclHostConsole, addWindowsAclInfrastructureFuse } from '../modules/platform/windows-acl-overlay.mjs'

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
const hasProductUpdatePlugin = enabledPlugins.some(item => item.id === 'tokens-version-updates')
const hasLoopGuardPlugin = enabledPlugins.some(item => item.id === 'tokens-loop-guard')

// 产品运行时由外层固定，安装时仍须通过 Yarn 补丁和 immutable 锁文件校验。
const desktopRuntimeVersion = manifest.desktop.runtimeVersion
if (typeof desktopRuntimeVersion !== 'string' || desktopRuntimeVersion.length === 0) {
  throw new Error('prepare-desktop: desktop runtimeVersion must be a non-empty string')
}
/* ====================================================================
 * 工具函数
 * 仅供本脚本使用的通用辅助。产品覆盖（改写上游副本的加工逻辑）按主题
 * 分类存放在 modules/ 目录，本文件只保留主流程与调用顺序。
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
 * 按顺序执行 staging 装配：重建目录、读入副本、各项产品加工、写回。
 * 以后新增的产品化操作按性质插入对应步骤之间，并加同款分节横幅。
 * ==================================================================== */

/* ------------------------ 重建 staging 目录 ------------------------- */
mkdirSync(stageRoot, { recursive: true })
assertGeneratedPath(stage)
clearStageKeepingModules()
copySource(desktopSource, stage)
prepareRuntimeVersion(stage, desktopRuntimeVersion)
cpSync(
  resolve(root, 'build', 'modules', 'platform', 'mac-adhoc-sign.ts'),
  resolve(stage, 'dsh-plugin-desktop', 'scripts', 'mac-unsigned-after-pack.ts'),
)
for (const [sourceName, destinationParts] of [
  ['host-console.ts', ['src', 'windows-acl-host-console.ts']],
  ['infrastructure-fuse.ts', ['src', 'windows-acl-infrastructure-fuse.ts']],
  ['product.spec.ts', ['tests', 'windows-acl-product.spec.ts']],
]) {
  cpSync(
    resolve(root, 'build', 'modules', 'platform', 'assets', 'windows', 'acl', sourceName),
    resolve(stage, 'dsh-plugin-desktop', ...destinationParts),
  )
}

/* ----------------------- 读入待改写的副本文件 ----------------------- */
const workspacePath = resolve(stage, 'package.json')
const desktopPackagePath = resolve(stage, 'dsh-plugin-desktop', 'package.json')
const desktopPatchPath = resolve(stage, 'dsh-plugin-desktop', 'cordis.patch.yml')
const profileBootVerifierPath = resolve(
  stage,
  'dsh-plugin-desktop',
  'scripts',
  'verify-profile-boot.mjs',
)
const cliRuntimeVerifierPath = resolve(
  stage,
  'dsh-plugin-desktop',
  'scripts',
  'verify-cli-runtime.mjs',
)
const desktopFsExtPreparePath = resolve(stage, 'dsh-plugin-desktop', 'scripts', 'prepare-fs-ext.ts')
const desktopMainPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'main.ts')
const desktopLoggerPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'desktop-logger.ts')
const desktopModuleResolutionTestsPath = resolve(stage, 'dsh-plugin-desktop', 'tests', 'module-resolution.spec.ts')
const windowsAclRunnerPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'windows-acl-runner.ts')
const windowsPwshSandboxPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'windows-pwsh-sandbox.ts')
const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
// 归一化 CRLF：Windows CI 的 git autocrlf 会把检出内容转成 CRLF，
// 不归一化时后续覆盖的 LF 锚点全部失配。
let desktopPatch = readFileSync(desktopPatchPath, 'utf8').replaceAll('\r\n', '\n').trimEnd()
let profileBootVerifier = readFileSync(profileBootVerifierPath, 'utf8')
let cliRuntimeVerifier = readFileSync(cliRuntimeVerifierPath, 'utf8')
let desktopMain = readFileSync(desktopMainPath, 'utf8')
let desktopLogger = readFileSync(desktopLoggerPath, 'utf8')
let desktopModuleResolutionTests = readFileSync(desktopModuleResolutionTestsPath, 'utf8')
desktopModuleResolutionTests = alignResolverTestFileUrls(desktopModuleResolutionTests)
let windowsAclRunner = readFileSync(windowsAclRunnerPath, 'utf8')
let windowsPwshSandbox = readFileSync(windowsPwshSandboxPath, 'utf8')

applyMarketSourceOverlays({ root, stage })

/* -------------------------- 配置自动更新 --------------------------- */
// TokensCowork 始终关闭指向官方 DSH Desktop 的更新服务。内置替代插件时
// 验收产品更新入口；纯净产品没有替代插件时，验收所有更新入口均已隐藏。
desktopPatch = disableUpstreamUpdates(desktopPatch)

/* -------------------------- 补丁层品牌覆盖 -------------------------- */
// 停用上游官方 UI 品牌插件；系统提示词身份行换成产品品牌。
desktopPatch = brandDesktopPatch(desktopPatch, manifest.product.name)
if (hasProductUpdatePlugin) {
  profileBootVerifier = verifyProductUpdateMenu(profileBootVerifier)
} else {
  profileBootVerifier = verifyDisabledUpdateMenu(profileBootVerifier)
}

/* -------------------------- 配置循环护栏 --------------------------- */
// 内置 tokens-loop-guard 时停用上游 repeat-tool-reminder,避免同一次
// 重复调用收到两条提醒;产品插件未启用时上游护栏保持原样兜底。
if (hasLoopGuardPlugin) {
  desktopPatch = disableUpstreamRepeatReminder(desktopPatch)
}

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
  if (plugin.id === 'dsh-tokensapi-ui') {
    const themeClientPath = resolve(destination, 'lib', 'client.js')
    writeFileSync(themeClientPath, preserveNativeDialogPosition(readFileSync(themeClientPath, 'utf8')))
  }

  // A script-built plugin keeps its declared toolchain only in staging. Pruning
  // removes it after the plugin has produced its runtime files; prebuilt and
  // legacy compiler inputs still avoid installing an unused local toolchain.
  const pluginPackagePath = resolve(destination, 'package.json')
  const pluginPackage = JSON.parse(readFileSync(pluginPackagePath, 'utf8'))
  alignRuntimeDependencies(pluginPackage, desktopRuntimeVersion)
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

/* ---------------------- 关闭首次设置向导 ------------------------- */
desktopMain = skipDesktopSetupWizard(desktopMain)

/* -------------------- 市场提供方固定为社区市场 -------------------- */
desktopMain = pinDesktopMarketProvider(desktopMain)

/* --------------------- 保护 GUI 启动诊断输出 ---------------------- */
;({ main: desktopMain, logger: desktopLogger } = protectDesktopStderr(desktopMain, desktopLogger))

/* -------------------- 对齐 CLI runtime smoke --------------------- */
cliRuntimeVerifier = alignCliRuntimeSmokeWithPlatform(cliRuntimeVerifier)

/* -------------------- 对齐最新原生运行时装配 --------------------- */
// Stable 已自带最新原生装配与物理运行时门禁；只补外层显式架构参数。
writeFileSync(desktopFsExtPreparePath, alignFsExtArchitecture(readFileSync(desktopFsExtPreparePath, 'utf8')))

/* -------------------- 修复 Windows ACL 启动链 -------------------- */
windowsAclRunner = addWindowsAclHostConsole(windowsAclRunner)
windowsPwshSandbox = addWindowsAclInfrastructureFuse(windowsPwshSandbox)

/* --------------------------- 写回改写结果 --------------------------- */
writeFileSync(workspacePath, `${JSON.stringify(workspace, undefined, 2)}\n`)
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(desktopPatchPath, `${desktopPatch}\n`)
writeFileSync(profileBootVerifierPath, profileBootVerifier)
writeFileSync(cliRuntimeVerifierPath, cliRuntimeVerifier)
writeFileSync(desktopMainPath, desktopMain)
writeFileSync(desktopLoggerPath, desktopLogger)
writeFileSync(desktopModuleResolutionTestsPath, desktopModuleResolutionTests)
writeFileSync(windowsAclRunnerPath, windowsAclRunner)
writeFileSync(windowsPwshSandboxPath, windowsPwshSandbox)

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
