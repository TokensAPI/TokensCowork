import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

/* ====================================================================
 * 路径与产品清单
 * 仓库根、staging 目录、desktop 子模块源目录，以及从 product.json
 * 读出的产品清单和默认启用的插件列表。
 * ==================================================================== */

const root = resolve(import.meta.dirname, '..')
const stageRoot = resolve(root, '.build')
const stage = resolve(stageRoot, 'desktop')
const desktopSource = resolve(root, 'desktop')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const enabledPlugins = manifest.plugins.filter(item => item.enabledByDefault === true)
const hasProductUpdatePlugin = enabledPlugins.some(item => item.id === 'tokens-version-updates')

/* ====================================================================
 * 工具函数
 * 仅供本脚本使用的辅助函数；新增的独立加工逻辑（改副本、加覆盖等）
 * 写成函数放在本区，再到主流程对应步骤中调用。
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

/**
 * 追加停用上游 desktop-updates 插件的覆盖条目，阻止官方 DSH Desktop 更新推送覆盖本产品。
 * @param patch - staging 副本中 cordis.patch.yml 的完整内容。
 * @returns 追加停用覆盖条目后的补丁内容。
 * @throws 上游 desktop-updates 注册条目与锚点不一致时抛出，中断打包待人工复查。
 */
function disableUpstreamUpdates(patch) {
  const upstreamEntry = '    - id: desktop-updates\n      name: dsh-plugin-desktop/updates'
  if (!patch.includes(upstreamEntry)) {
    throw new Error('prepare-desktop: 未找到上游 desktop-updates 注册条目，请复查更新覆盖配置')
  }
  return `${patch}\n\n# 产品覆盖：上游更新服务指向官方 DSH Desktop，与本产品无关，予以停用。\n`
    + '- id: desktop-updates\n  disabled: true'
}

/**
 * 将上游启动验收改为产品更新菜单验收：旧菜单必须消失，新菜单必须存在。
 * 产品停用 desktop-updates 后，原校验会把产品插件提供的菜单误判为上游菜单。
 * @param script - staging 副本中 verify-profile-boot.mjs 的完整内容。
 * @returns 与产品更新策略一致的启动验收脚本。
 * @throws 上游校验锚点变化时抛出，中断打包待人工复查。
 */
function verifyProductUpdateMenu(script) {
  const upstreamCheck = `  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }`
  if (!script.includes(upstreamCheck)) {
    throw new Error('prepare-desktop: 未找到上游更新菜单验收锚点，请复查产品更新策略')
  }
  return script.replace(
    upstreamCheck,
    `  if (trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled product profile unexpectedly retains the upstream update tray command')
  }
  if (!trayItems.some(item => item.label() === 'Check Updates…')) {
    throw new Error('assembled product profile is missing the product update tray command')
  }`,
  )
}

/**
 * 将上游启动验收改为无更新菜单验收：官方更新已停用，且产品没有内置替代插件。
 * @param script - staging 副本中 verify-profile-boot.mjs 的完整内容。
 * @returns 与纯净产品更新策略一致的启动验收脚本。
 * @throws 上游校验锚点变化时抛出，中断打包待人工复查。
 */
function verifyDisabledUpdateMenu(script) {
  const upstreamCheck = `  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }`
  if (!script.includes(upstreamCheck)) {
    throw new Error('prepare-desktop: 未找到上游更新菜单验收锚点，请复查产品更新策略')
  }
  return script.replace(
    upstreamCheck,
    `  if (trayItems.some(item => item.label() === 'Check for Updates…'
    || item.label() === 'Check Updates…')) {
    throw new Error('assembled clean product profile unexpectedly retains an update tray command')
  }`,
  )
}

/**
 * 从持久 profile 的 bundle 列表中移除由产品补丁固定装配的插件。
 * 旧版本可能把这些插件写入用户 profile，升级后会与产品 Loader 条目重复。
 * @param source - staging 副本中 profile.ts 的完整内容。
 * @param packages - 当前产品默认启用、由产品补丁托管的插件包名。
 * @returns 启动时会自动修复旧 profile 的源码。
 * @throws 上游 profile 规范化锚点变化时抛出，中断打包待人工复查。
 */
function removeManagedBundlesFromProfile(source, packages) {
  const setAnchor = 'const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)'
  const filterAnchor = '  const thirdParty = current.filter(name => !REQUIRED_BUNDLE_SET.has(name) && name !== DESKTOP_PACKAGE_NAME)'
  if (!source.includes(setAnchor) || !source.includes(filterAnchor)) {
    throw new Error('prepare-desktop: 未找到上游 profile bundle 规范化锚点，请复查产品插件迁移策略')
  }
  const managedPackages = JSON.stringify(packages, undefined, 2)
    .split('\n')
    .map((line, index) => index === 0 ? line : `  ${line}`)
    .join('\n')
  return source
    .replace(
      setAnchor,
      `${setAnchor}\nconst PRODUCT_MANAGED_BUNDLE_SET = new Set<string>(${managedPackages})`,
    )
    .replace(
      filterAnchor,
      `  const thirdParty = current.filter(name => !REQUIRED_BUNDLE_SET.has(name)\n    && name !== DESKTOP_PACKAGE_NAME\n    && !PRODUCT_MANAGED_BUNDLE_SET.has(name))`,
    )
}

/**
 * 避免 Windows GUI 启动时已断开的 stderr 管道再次抛出 EPIPE，掩盖原始异常。
 * @param source - staging 副本中 main.ts 的完整内容。
 * @returns 所有桌面诊断均通过容错 writer 输出的源码。
 * @throws 上游 stderr 锚点变化时抛出，中断打包待人工复查。
 */
function protectDesktopStderr(source) {
  const helperAnchor = "const PRODUCT_NAME = 'DSH Desktop'"
  const failLoudAnchor = '    stderr: process.stderr,'
  const directWrites = source.match(/process\.stderr\.write\(/g) ?? []
  if (!source.includes(helperAnchor) || !source.includes(failLoudAnchor) || directWrites.length === 0) {
    throw new Error('prepare-desktop: 未找到上游桌面 stderr 锚点，请复查 Windows GUI 异常处理')
  }
  const rewritten = source
    .replaceAll('process.stderr.write(', 'writeDesktopStderr(')
    .replace(failLoudAnchor, '    stderr: { write: writeDesktopStderr },')
    .replace(
      helperAnchor,
      `${helperAnchor}\n\n// A Windows GUI launch may expose an already-closed stderr pipe.\nprocess.stderr.on('error', () => {})\n\n/** Write diagnostics when a live stderr pipe exists. */\nfunction writeDesktopStderr(message: string): void {\n  if (process.stderr.destroyed || !process.stderr.writable) return\n  try {\n    process.stderr.write(message)\n  } catch {\n    // Diagnostics must never replace the original startup outcome.\n  }\n}`,
    )
  if ((rewritten.match(/process\.stderr\.write\(/g) ?? []).length !== 1) {
    throw new Error('prepare-desktop: 桌面 stderr 改写不完整，请复查 Windows GUI 异常处理')
  }
  return rewritten
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
  resolve(root, 'build', 'mac-unsigned-after-pack.ts'),
  resolve(stage, 'dsh-plugin-desktop', 'scripts', 'mac-unsigned-after-pack.ts'),
)

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
const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
let desktopPatch = readFileSync(desktopPatchPath, 'utf8').trimEnd()
let profileBootVerifier = readFileSync(profileBootVerifierPath, 'utf8')
let desktopProfile = readFileSync(desktopProfilePath, 'utf8')
let desktopMain = readFileSync(desktopMainPath, 'utf8')

/* -------------------------- 配置自动更新 --------------------------- */
// TokensHarness 始终关闭指向官方 DSH Desktop 的更新服务。内置替代插件时
// 验收产品更新入口；纯净产品没有替代插件时，验收所有更新入口均已隐藏。
desktopPatch = disableUpstreamUpdates(desktopPatch)
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

  // Product plugins ship committed runtime artifacts. Their local build toolchains
  // are not part of the redistributed application and make cross-platform installs
  // slower and less deterministic (especially native esbuild helper packages).
  const pluginPackagePath = resolve(destination, 'package.json')
  const pluginPackage = JSON.parse(readFileSync(pluginPackagePath, 'utf8'))
  pluginPackage.name = plugin.package
  delete pluginPackage.devDependencies
  delete pluginPackage.allowScripts
  writeFileSync(pluginPackagePath, `${JSON.stringify(pluginPackage, undefined, 2)}\n`)

  const workspaceEntry = relative(stage, destination).split(sep).join('/')
  if (!workspace.workspaces.includes(workspaceEntry)) workspace.workspaces.push(workspaceEntry)
  desktopPackage.dependencies[plugin.package] = 'workspace:*'
  for (const [name, version] of Object.entries(plugin.runtimeDependencies ?? {})) {
    desktopPackage.dependencies[name] = version
    if (desktopPackage.devDependencies?.[name] !== undefined) delete desktopPackage.devDependencies[name]
  }

  const pluginPatch = renamePluginPatchPackage(
    readFileSync(resolve(source, plugin.patch), 'utf8').trim(),
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
desktopMain = protectDesktopStderr(desktopMain)

/* --------------------------- 写回改写结果 --------------------------- */
writeFileSync(workspacePath, `${JSON.stringify(workspace, undefined, 2)}\n`)
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(desktopPatchPath, `${desktopPatch}\n`)
writeFileSync(profileBootVerifierPath, profileBootVerifier)
writeFileSync(desktopProfilePath, desktopProfile)
writeFileSync(desktopMainPath, desktopMain)

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
