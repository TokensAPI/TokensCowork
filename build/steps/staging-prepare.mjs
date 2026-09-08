import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

import { brandDesktopPatch } from '../overlays/branding-overlay.mjs'
import { addMarketAuth, skipUpstreamPersistedCatalogTest } from '../overlays/market/market-auth-overlay.mjs'
import { preserveNativeDialogPosition } from '../overlays/market/market-dialog-position-overlay.mjs'
import { addMarketUpdates, addMarketUpdateChecks, addMarketUpdateUiTests, addMarketUpdateApiTests } from '../overlays/market/market-update-overlay.mjs'
import {
  alignCliRuntimeSmokeWithPlatform,
  alignStablePackageRuntimeTests,
  pinDesktopMarketProvider,
  protectDesktopStderr,
  skipDesktopSetupWizard,
} from '../overlays/desktop-runtime-overlay.mjs'
import { addRequiredSourceRepairTest, allowMarketSourceSyntheticProxy, awaitProductSourceMigrationInLifecycleTest, pinProductMarketSource, skipUpstreamAddSourceOverlayTests, skipUpstreamBuiltInRuntimeTests, skipUpstreamBuiltInSourceTests, skipUpstreamSourceDescriptionTests } from '../overlays/market/market-source-overlay.mjs'
import { disableUpstreamUpdates, verifyDisabledUpdateMenu, verifyProductUpdateMenu } from '../overlays/updates-overlay.mjs'
import { addWindowsAclHostConsole, addWindowsAclInfrastructureFuse } from '../overlays/windows-acl-overlay.mjs'

/* ====================================================================
 * 路径与产品清单
 * 仓库根、staging 目录、desktop 子模块源目录，以及从 product.json
 * 读出的产品清单和默认启用的插件列表。
 * ==================================================================== */

const root = resolve(import.meta.dirname, '..', '..')
const stageRoot = resolve(root, '.build')
const refreshingLock = process.env.PRODUCT_REFRESH_LOCK === '1'
const stage = resolve(stageRoot, refreshingLock ? 'refresh-lock' : 'desktop')
const desktopSource = resolve(root, 'desktop')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const enabledPlugins = manifest.plugins.filter(item => item.enabledByDefault === true)
const hasProductUpdatePlugin = enabledPlugins.some(item => item.id === 'tokens-version-updates')

/* ====================================================================
 * 工具函数
 * 仅供本脚本使用的通用辅助。产品覆盖（改写上游副本的加工逻辑）按主题
 * 分类存放在 overlays/ 目录，本文件只保留主流程与调用顺序。
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
cpSync(
  resolve(root, 'build', 'hooks', 'mac-adhoc-sign.ts'),
  resolve(stage, 'dsh-plugin-desktop', 'scripts', 'mac-unsigned-after-pack.ts'),
)
for (const [sourceName, destinationParts] of [
  ['host-console.ts', ['src', 'windows-acl-host-console.ts']],
  ['infrastructure-fuse.ts', ['src', 'windows-acl-infrastructure-fuse.ts']],
  ['product.spec.ts', ['tests', 'windows-acl-product.spec.ts']],
]) {
  cpSync(
    resolve(root, 'build', 'assets', 'windows', 'acl', sourceName),
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
const desktopRuntimeVerifierPath = resolve(
  stage,
  'dsh-plugin-desktop',
  'scripts',
  'verify-packaged-runtime.ts',
)
const betaRuntimeVerifierPath = resolve(
  stage,
  'dsh-plugin-desktop-beta',
  'scripts',
  'verify-packaged-runtime.ts',
)
const desktopMacUniversalPath = resolve(stage, 'dsh-plugin-desktop', 'scripts', 'mac-universal.ts')
const betaMacUniversalPath = resolve(stage, 'dsh-plugin-desktop-beta', 'scripts', 'mac-universal.ts')
const desktopFsExtPreparePath = resolve(stage, 'dsh-plugin-desktop', 'scripts', 'prepare-fs-ext.ts')
const betaFsExtPreparePath = resolve(stage, 'dsh-plugin-desktop-beta', 'scripts', 'prepare-fs-ext.ts')
const desktopPackageTestsPath = resolve(stage, 'dsh-plugin-desktop', 'tests', 'package.spec.ts')
const betaPackageTestsPath = resolve(stage, 'dsh-plugin-desktop-beta', 'tests', 'package.spec.ts')
const desktopRuntimeVerifierTestsPath = resolve(
  stage,
  'dsh-plugin-desktop',
  'tests',
  'verify-packaged-runtime.spec.ts',
)
const betaRuntimeVerifierTestsPath = resolve(
  stage,
  'dsh-plugin-desktop-beta',
  'tests',
  'verify-packaged-runtime.spec.ts',
)
const desktopMacUniversalTestsPath = resolve(stage, 'dsh-plugin-desktop', 'tests', 'mac-universal.spec.ts')
const betaMacUniversalTestsPath = resolve(stage, 'dsh-plugin-desktop-beta', 'tests', 'mac-universal.spec.ts')
const desktopFsExtPrepareTestsPath = resolve(stage, 'dsh-plugin-desktop', 'tests', 'prepare-fs-ext.spec.ts')
const betaFsExtPrepareTestsPath = resolve(stage, 'dsh-plugin-desktop-beta', 'tests', 'prepare-fs-ext.spec.ts')
const desktopProfilePath = resolve(stage, 'dsh-plugin-desktop', 'src', 'profile.ts')
const desktopMainPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'main.ts')
const desktopLoggerPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'desktop-logger.ts')
const desktopModuleResolutionPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'module-resolution.ts')
const desktopModuleResolutionTestsPath = resolve(stage, 'dsh-plugin-desktop', 'tests', 'module-resolution.spec.ts')
const windowsAclRunnerPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'windows-acl-runner.ts')
const windowsPwshSandboxPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'windows-pwsh-sandbox.ts')
const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
const desktopRuntimeVersion = manifest.desktop.runtimeVersion
if (typeof desktopRuntimeVersion !== 'string' || desktopRuntimeVersion.length === 0) {
  throw new Error('prepare-desktop: desktop runtimeVersion must be a non-empty string')
}
const betaDesktopPackage = JSON.parse(readFileSync(
  resolve(stage, 'dsh-plugin-desktop-beta', 'package.json'),
  'utf8',
))
const latestRuntimeDependencies = Object.entries(betaDesktopPackage.dependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
if (latestRuntimeDependencies.length === 0
  || latestRuntimeDependencies.some(([, version]) => version !== desktopRuntimeVersion)) {
  throw new Error('prepare-desktop: upstream beta runtime differs from product.json')
}
for (const [name, version] of latestRuntimeDependencies) {
  desktopPackage.dependencies[name] = version
}
for (const name of Object.keys(desktopPackage.dependencies ?? {})) {
  if ((name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    && !latestRuntimeDependencies.some(([runtimeName]) => runtimeName === name)) {
    delete desktopPackage.dependencies[name]
  }
}
const betaFsExtVersion = betaDesktopPackage.dependencies?.['fs-ext']
const betaFsExtExclude = '!node_modules/fs-ext/build/**'
if (typeof betaFsExtVersion !== 'string'
  || betaFsExtVersion.length === 0
  || betaDesktopPackage.scripts?.['prepare:electron-native'] !== 'node scripts/prepare-fs-ext.ts'
  || !betaDesktopPackage.build?.files?.includes(betaFsExtExclude)
  || typeof betaDesktopPackage.build?.mac?.x64ArchFiles !== 'string'
  || !betaDesktopPackage.build.mac.x64ArchFiles.includes('fs-ext/prebuilds/darwin-*/**')) {
  throw new Error('prepare-desktop: upstream beta fs-ext packaging contract is incomplete')
}
desktopPackage.dependencies['fs-ext'] = betaFsExtVersion
desktopPackage.scripts['prepare:electron-native'] = betaDesktopPackage.scripts['prepare:electron-native']
if (!desktopPackage.build.files.includes(betaFsExtExclude)) {
  desktopPackage.build.files.push(betaFsExtExclude)
}
desktopPackage.build.mac.x64ArchFiles = betaDesktopPackage.build.mac.x64ArchFiles
// 归一化 CRLF：Windows CI 的 git autocrlf 会把检出内容转成 CRLF，
// 不归一化时后续覆盖的 LF 锚点全部失配。
let desktopPatch = readFileSync(desktopPatchPath, 'utf8').replaceAll('\r\n', '\n').trimEnd()
let profileBootVerifier = readFileSync(profileBootVerifierPath, 'utf8')
let cliRuntimeVerifier = readFileSync(cliRuntimeVerifierPath, 'utf8')
let desktopPackageTests = readFileSync(desktopPackageTestsPath, 'utf8')
const betaPackageTests = readFileSync(betaPackageTestsPath, 'utf8')
const betaRuntimeVerifierTests = readFileSync(betaRuntimeVerifierTestsPath, 'utf8')
  .replaceAll('DSH Desktop Beta', 'DSH Desktop')
  .replaceAll('dsh-plugin-desktop-beta', 'dsh-plugin-desktop')
let desktopProfile = readFileSync(desktopProfilePath, 'utf8')
let desktopMain = readFileSync(desktopMainPath, 'utf8')
let desktopLogger = readFileSync(desktopLoggerPath, 'utf8')
let desktopModuleResolution = readFileSync(desktopModuleResolutionPath, 'utf8')
let desktopModuleResolutionTests = readFileSync(desktopModuleResolutionTestsPath, 'utf8')
let windowsAclRunner = readFileSync(windowsAclRunnerPath, 'utf8')
let windowsPwshSandbox = readFileSync(windowsPwshSandboxPath, 'utf8')

/* -------------------------- 配置插件市场 --------------------------- */
// 产品插件源部署在 market/source.config.json 声明的 origin；为其加入
// 市场受限 HTTP 客户端的 fake-IP 代理豁免，保证国内代理环境可添加。
const marketSourceConfig = JSON.parse(readFileSync(resolve(root, 'market', 'source.config.json'), 'utf8'))
const marketHttpPath = resolve(stage, 'dsh-community-market', 'src', 'network', 'restricted-http.ts')
writeFileSync(marketHttpPath, allowMarketSourceSyntheticProxy(
  readFileSync(marketHttpPath, 'utf8'),
  new URL(marketSourceConfig.origin).hostname,
))

// 预置产品目录源为唯一入口：默认选中、隐藏上游合作源与添加/删除入口，
// 同时精简固定来源页面的说明信息。
const marketSourceManifest = JSON.parse(readFileSync(resolve(root, 'market', 'source.json'), 'utf8'))
const marketIndexPath = resolve(stage, 'dsh-community-market', 'src', 'index.ts')
const marketRoutesPath = resolve(stage, 'dsh-community-market', 'src', 'host', 'routes.ts')
const marketSourceStorePath = resolve(stage, 'dsh-community-market', 'src', 'catalog', 'source-store.ts')
const marketServicePath = resolve(stage, 'dsh-community-market', 'src', 'catalog', 'service.ts')
const marketSettingsTabPath = resolve(stage, 'dsh-community-market', 'src', 'client', 'MarketSettingsTab.tsx')
const marketLocalesPath = resolve(stage, 'dsh-community-market', 'src', 'client', 'locales.ts')
const pinnedMarket = pinProductMarketSource({
  index: readFileSync(marketIndexPath, 'utf8'),
  routes: readFileSync(marketRoutesPath, 'utf8'),
  sourceStore: readFileSync(marketSourceStorePath, 'utf8'),
  service: readFileSync(marketServicePath, 'utf8'),
  settingsTab: readFileSync(marketSettingsTabPath, 'utf8'),
  locales: readFileSync(marketLocalesPath, 'utf8'),
}, marketSourceConfig.origin, marketSourceManifest)
writeFileSync(marketIndexPath, pinnedMarket.index)
writeFileSync(marketRoutesPath, pinnedMarket.routes)
writeFileSync(marketSourceStorePath, pinnedMarket.sourceStore)
writeFileSync(marketServicePath, pinnedMarket.service)
writeFileSync(marketSettingsTabPath, pinnedMarket.settingsTab)
writeFileSync(marketLocalesPath, pinnedMarket.locales)
const authenticatedMarket = addMarketAuth({
  index: readFileSync(marketIndexPath, 'utf8'),
  http: readFileSync(marketHttpPath, 'utf8'),
  routes: readFileSync(marketRoutesPath, 'utf8'),
}, marketSourceConfig.origin)
writeFileSync(marketHttpPath, authenticatedMarket.http)
writeFileSync(marketRoutesPath, authenticatedMarket.routes)
writeFileSync(marketIndexPath, authenticatedMarket.index)

/* ----------------------- 适配固定市场源测试 ------------------------ */
// 产品只暴露一个固定目录源；跳过上游多来源管理用例，并保留产品源迁移、
// 自愈测试。插件安装与卸载测试继续完整运行上游最新版行为。
const marketHostTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'host-routes.spec.ts')
writeFileSync(marketHostTestsPath, skipUpstreamBuiltInSourceTests(readFileSync(marketHostTestsPath, 'utf8')))
writeFileSync(marketHostTestsPath, skipUpstreamPersistedCatalogTest(readFileSync(marketHostTestsPath, 'utf8')))
const marketRuntimeTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-runtime.spec.ts')
writeFileSync(marketRuntimeTestsPath, skipUpstreamBuiltInRuntimeTests(readFileSync(marketRuntimeTestsPath, 'utf8')))
const marketOverlayTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'client-overlay.spec.tsx')
writeFileSync(marketOverlayTestsPath, skipUpstreamAddSourceOverlayTests(readFileSync(marketOverlayTestsPath, 'utf8')))
const marketSettingsTabTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-settings-tab.spec.tsx')
writeFileSync(
  marketSettingsTabTestsPath,
  skipUpstreamSourceDescriptionTests(readFileSync(marketSettingsTabTestsPath, 'utf8')),
)
const marketUpdatePaths = {
  service: resolve(stage, 'dsh-community-market', 'src', 'install', 'service.ts'),
  routes: marketRoutesPath,
  types: resolve(stage, 'dsh-community-market', 'src', 'api-types.ts'),
  settingsTab: marketSettingsTabPath,
  locales: marketLocalesPath,
}
const marketUpdates = addMarketUpdates(Object.fromEntries(
  Object.entries(marketUpdatePaths).map(([key, path]) => [key, readFileSync(path, 'utf8')]),
))
for (const [key, path] of Object.entries(marketUpdatePaths)) writeFileSync(path, marketUpdates[key])
const marketClientApiPath = resolve(stage, 'dsh-community-market', 'src', 'client', 'api.ts')
writeFileSync(marketClientApiPath, addMarketUpdateChecks(readFileSync(marketClientApiPath, 'utf8')))
writeFileSync(marketSettingsTabTestsPath, addMarketUpdateUiTests(readFileSync(marketSettingsTabTestsPath, 'utf8')))
const marketClientApiTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'client-api.spec.ts')
writeFileSync(marketClientApiTestsPath, addMarketUpdateApiTests(readFileSync(marketClientApiTestsPath, 'utf8')))
cpSync(resolve(root, 'build', 'overlays', 'market', 'market-update.spec.ts'),
  resolve(stage, 'dsh-community-market', 'tests', 'market-update.spec.ts'))
const marketSourceStoreTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'source-store.spec.ts')
writeFileSync(
  marketSourceStoreTestsPath,
  addRequiredSourceRepairTest(readFileSync(marketSourceStoreTestsPath, 'utf8')),
)
const marketLifecycleTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-host-lifecycle.spec.ts')
writeFileSync(
  marketLifecycleTestsPath,
  awaitProductSourceMigrationInLifecycleTest(readFileSync(marketLifecycleTestsPath, 'utf8')),
)

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
desktopPackageTests = alignStablePackageRuntimeTests(desktopPackageTests, betaPackageTests)

/* -------------------- 对齐最新原生运行时装配 --------------------- */
// Stable 产品使用 Beta 的 DSH alpha 运行时，也同步其 fs-ext Electron ABI
// 准备、macOS 双架构清单和物理运行时门禁；所有改动仍只落在 staging。
cpSync(betaFsExtPreparePath, desktopFsExtPreparePath)
cpSync(betaMacUniversalPath, desktopMacUniversalPath)
cpSync(betaRuntimeVerifierPath, desktopRuntimeVerifierPath)
cpSync(betaFsExtPrepareTestsPath, desktopFsExtPrepareTestsPath)
cpSync(betaMacUniversalTestsPath, desktopMacUniversalTestsPath)
writeFileSync(desktopRuntimeVerifierTestsPath, betaRuntimeVerifierTests)
const fsExtCliAnchor = '  prepareFsExtForElectron({ log: message => console.log(message) })'
const fsExtPrepareSource = readFileSync(desktopFsExtPreparePath, 'utf8')
if (fsExtPrepareSource.split(fsExtCliAnchor).length !== 2) {
  throw new Error('prepare-desktop: upstream beta fs-ext CLI anchor is missing or ambiguous')
}
writeFileSync(
  desktopFsExtPreparePath,
  fsExtPrepareSource.replace(
    fsExtCliAnchor,
    "  prepareFsExtForElectron({ arch: process.argv[2] ?? process.arch, log: message => console.log(message) })",
  ),
)

/* -------------------- 修复 Windows ACL 启动链 -------------------- */
windowsAclRunner = addWindowsAclHostConsole(windowsAclRunner)
windowsPwshSandbox = addWindowsAclInfrastructureFuse(windowsPwshSandbox)

/* --------------------------- 写回改写结果 --------------------------- */
writeFileSync(workspacePath, `${JSON.stringify(workspace, undefined, 2)}\n`)
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(desktopPatchPath, `${desktopPatch}\n`)
writeFileSync(profileBootVerifierPath, profileBootVerifier)
writeFileSync(cliRuntimeVerifierPath, cliRuntimeVerifier)
writeFileSync(desktopPackageTestsPath, desktopPackageTests)
writeFileSync(desktopProfilePath, desktopProfile)
writeFileSync(desktopMainPath, desktopMain)
writeFileSync(desktopLoggerPath, desktopLogger)
writeFileSync(desktopModuleResolutionPath, desktopModuleResolution)
writeFileSync(desktopModuleResolutionTestsPath, desktopModuleResolutionTests)
writeFileSync(windowsAclRunnerPath, windowsAclRunner)
writeFileSync(windowsPwshSandboxPath, windowsPwshSandbox)

/* -------------------------- 安装产品锁文件 -------------------------- */
if (enabledPlugins.length > 0) {
  const productLock = resolve(root, 'build', 'product.yarn.lock')
  if (existsSync(productLock)) {
    cpSync(productLock, resolve(stage, 'yarn.lock'))
  } else if (process.env.PRODUCT_REFRESH_LOCK !== '1') {
    throw new Error('prepare-desktop: enabled plugins require build/product.yarn.lock; run product:refresh-lock')
  }
}

/* --------------------------- 输出装配摘要 --------------------------- */
process.stdout.write(
  `prepare-desktop: staged ${manifest.product.name} ${manifest.product.version} from ${manifest.desktop.commit.slice(0, 10)} with DSH ${desktopRuntimeVersion} and ${enabledPlugins.length} default plugin(s) at ${stage}\n`,
)
