import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

import { brandDesktopPatch } from './overlays/branding.mjs'
import { removeManagedBundlesFromProfile, protectDesktopStderr } from './overlays/desktop-runtime.mjs'
import { addRequiredSourceRepairTest, allowMarketSourceSyntheticProxy, awaitProductSourceMigrationInLifecycleTest, pinProductMarketSource, skipUpstreamAddSourceOverlayTests, skipUpstreamBuiltInRuntimeTests, skipUpstreamBuiltInSourceTests, skipUpstreamSourceDescriptionTests } from './overlays/market.mjs'
import { disableUpstreamUpdates, verifyDisabledUpdateMenu, verifyProductUpdateMenu } from './overlays/updates.mjs'
import { addWindowsAclHostConsole, addWindowsAclInfrastructureFuse } from './overlays/windows-acl.mjs'

/* ====================================================================
 * 路径与产品清单
 * 仓库根、staging 目录、desktop 子模块源目录，以及从 product.json
 * 读出的产品清单和默认启用的插件列表。
 * ==================================================================== */

const root = resolve(import.meta.dirname, '..', '..')
const stageRoot = resolve(root, '.build')
const stage = resolve(stageRoot, process.env.PRODUCT_REFRESH_LOCK === '1' ? 'refresh-lock' : 'desktop')
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
if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
copySource(desktopSource, stage)
cpSync(
  resolve(root, 'build', 'macos', 'unsigned-after-pack.ts'),
  resolve(stage, 'dsh-plugin-desktop', 'scripts', 'mac-unsigned-after-pack.ts'),
)
for (const [sourceName, destinationParts] of [
  ['host-console.ts', ['src', 'windows-acl-host-console.ts']],
  ['infrastructure-fuse.ts', ['src', 'windows-acl-infrastructure-fuse.ts']],
  ['product.spec.ts', ['tests', 'windows-acl-product.spec.ts']],
]) {
  cpSync(
    resolve(root, 'build', 'assembly', 'assets', 'windows', 'acl', sourceName),
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
const desktopProfilePath = resolve(stage, 'dsh-plugin-desktop', 'src', 'profile.ts')
const desktopMainPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'main.ts')
const desktopLoggerPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'desktop-logger.ts')
const windowsAclRunnerPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'windows-acl-runner.ts')
const windowsPwshSandboxPath = resolve(stage, 'dsh-plugin-desktop', 'src', 'windows-pwsh-sandbox.ts')
const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
// 归一化 CRLF：Windows CI 的 git autocrlf 会把检出内容转成 CRLF，
// 不归一化时后续覆盖的 LF 锚点全部失配。
let desktopPatch = readFileSync(desktopPatchPath, 'utf8').replaceAll('\r\n', '\n').trimEnd()
let profileBootVerifier = readFileSync(profileBootVerifierPath, 'utf8')
let desktopProfile = readFileSync(desktopProfilePath, 'utf8')
let desktopMain = readFileSync(desktopMainPath, 'utf8')
let desktopLogger = readFileSync(desktopLoggerPath, 'utf8')
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
const marketHostTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'host-routes.spec.ts')
writeFileSync(marketHostTestsPath, skipUpstreamBuiltInSourceTests(readFileSync(marketHostTestsPath, 'utf8')))
const marketRuntimeTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-runtime.spec.ts')
writeFileSync(marketRuntimeTestsPath, skipUpstreamBuiltInRuntimeTests(readFileSync(marketRuntimeTestsPath, 'utf8')))
const marketOverlayTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'client-overlay.spec.tsx')
writeFileSync(marketOverlayTestsPath, skipUpstreamAddSourceOverlayTests(readFileSync(marketOverlayTestsPath, 'utf8')))
const marketSettingsTabTestsPath = resolve(stage, 'dsh-community-market', 'tests', 'market-settings-tab.spec.tsx')
writeFileSync(
  marketSettingsTabTestsPath,
  skipUpstreamSourceDescriptionTests(readFileSync(marketSettingsTabTestsPath, 'utf8')),
)
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

/* ----------------------- 修复旧版持久 profile ---------------------- */
desktopProfile = removeManagedBundlesFromProfile(
  desktopProfile,
  enabledPlugins.map(plugin => plugin.package),
)

/* --------------------- 保护 GUI 启动诊断输出 ---------------------- */
;({ main: desktopMain, logger: desktopLogger } = protectDesktopStderr(desktopMain, desktopLogger))

/* -------------------- 修复 Windows ACL 启动链 -------------------- */
windowsAclRunner = addWindowsAclHostConsole(windowsAclRunner)
windowsPwshSandbox = addWindowsAclInfrastructureFuse(windowsPwshSandbox)

/* --------------------------- 写回改写结果 --------------------------- */
writeFileSync(workspacePath, `${JSON.stringify(workspace, undefined, 2)}\n`)
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(desktopPatchPath, `${desktopPatch}\n`)
writeFileSync(profileBootVerifierPath, profileBootVerifier)
writeFileSync(desktopProfilePath, desktopProfile)
writeFileSync(desktopMainPath, desktopMain)
writeFileSync(desktopLoggerPath, desktopLogger)
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
  `prepare-desktop: staged ${manifest.product.name} ${manifest.product.version} from ${manifest.desktop.commit.slice(0, 10)} with ${enabledPlugins.length} default plugin(s) at ${stage}\n`,
)
