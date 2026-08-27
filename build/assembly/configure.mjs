/* ====================================================================
 * 产品配置（打包前）
 * 在依赖安装完成的 staging 上注入品牌、安装器保护与打包参数。
 * 产品覆盖的具体加工逻辑按主题存放在 overlays/ 目录；本文件只保留
 * 路径解析、读入副本、按序调用与写回。
 * ==================================================================== */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import {
  applyProductLogo,
  assertBrandingAnchors,
  brandDesktopMain,
  upstreamProductName,
  upstreamRuntimeProductName,
  upstreamWindowTitle,
} from './overlays/branding.mjs'
import { configureProductUpdates } from './overlays/updates.mjs'
import { applyWindowsInstallerGuard, pinNsisResources } from './overlays/windows-installer.mjs'

/* ----------------------- 路径与产品清单 ----------------------- */
const root = resolve(import.meta.dirname, '..', '..')
const stage = resolve(root, '.build', 'desktop')
const productBrandRoot = resolve(import.meta.dirname, 'assets', 'brand')
const windowsInstallerRoot = resolve(import.meta.dirname, 'assets', 'windows')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const product = manifest.product
const hasProductUpdatePlugin = manifest.plugins.some(
  plugin => plugin.id === 'tokens-version-updates' && plugin.enabledByDefault === true,
)
const repositoryMatch = /^(?<owner>[^/]+)\/(?<repo>[^/]+)$/u.exec(product.repository ?? '')
if (repositoryMatch?.groups === undefined) {
  throw new Error('configure-product: product repository must use owner/repository format')
}
const legacyProductNames = product.legacyNames ?? []
if (!Array.isArray(legacyProductNames)
  || legacyProductNames.some(name => typeof name !== 'string' || name.trim() === '')) {
  throw new Error('configure-product: product legacyNames must be a list of non-empty strings')
}
const packagingTarget = process.argv[2] ?? 'default'
if (!['default', 'windows'].includes(packagingTarget)) {
  throw new Error('configure-product: expected default or windows packaging target')
}

const desktopRoot = resolve(stage, 'dsh-plugin-desktop')
const desktopPackagePath = resolve(desktopRoot, 'package.json')
const verifyMacReleasePath = resolve(desktopRoot, 'scripts', 'verify-mac-release.ts')
const releaseMacPath = resolve(desktopRoot, 'scripts', 'release-mac.ts')
const mainPath = resolve(desktopRoot, 'src', 'main.ts')
const indexPath = resolve(desktopRoot, 'src', 'index.ts')
const assistedMessagesPath = resolve(desktopRoot, 'build', 'assistedMessages.yml')
const windowsInstallerIncludePath = resolve(desktopRoot, 'build', 'tokenscowork-upgrade-guard.nsh')
const desktopPatchPath = resolve(desktopRoot, 'cordis.patch.yml')

/* ----------------------- 读入待改写的副本 ----------------------- */
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
const verifyMacRelease = readFileSync(verifyMacReleasePath, 'utf8')
const releaseMac = readFileSync(releaseMacPath, 'utf8')
const main = readFileSync(mainPath, 'utf8')
const index = readFileSync(indexPath, 'utf8')
const assistedMessages = readFileSync(assistedMessagesPath, 'utf8')

/* ----------------------- 打包参数（非覆盖） ----------------------- */
// Windows x64 只排除不可能参与该目标运行的原生架构，以及 Node 运行时不会读取的
// 调试/类型元数据。完整 JavaScript 运行时仍由现有 asarUnpack 和 afterPack 门禁保护。
const windowsX64RuntimeExclusions = [
  '!node_modules/@img/sharp-win32-{arm64,ia32}/**',
  '!node_modules/@koromix/koffi-win32-{arm64,ia32}/**',
  '!node_modules/@vscode/ripgrep-win32-{arm64,ia32}/**',
  '!node_modules/node-addon-require-builtin-win32-{arm64,ia32}-msvc/**',
  '!node_modules/node-pty/prebuilds/{darwin-*,linux-*,win32-arm64,win32-ia32}/**',
  '!node_modules/**/*.map',
  '!node_modules/**/*.{d.ts,d.mts,d.cts}',
]
const upstreamReleaseCheck = `  // The workspace check includes the package build and repository-layout gate. Signing
  // material is withheld from every build, test, Loader smoke, and layout subprocess.
  options.run('yarn', ['run', 'check'], resolve(options.desktopRoot, '..'), buildEnvironment)
`

/** 确保产品配置只改写 staging 副本。 */
function assertGeneratedPath(path) {
  if (path !== stage && !path.startsWith(`${stage}${sep}`)) {
    throw new Error(`configure-product: generated path escaped staging: ${path}`)
  }
}

/* --------------------------- 锚点校验 --------------------------- */
assertBrandingAnchors({ verifyMacRelease, main, index, assistedMessages })
if (!releaseMac.includes(upstreamReleaseCheck)) {
  throw new Error('configure-product: cannot locate redundant macOS release check')
}

/* ----------------------- electron-builder ----------------------- */
desktopPackage.version = product.version
desktopPackage.build.appId = product.appId
desktopPackage.build.productName = product.name
desktopPackage.build.nsis.shortcutName = product.name
desktopPackage.build.nsis.artifactName = `${product.name}-\${version}-\${arch}-Setup.\${ext}`
if (!Array.isArray(desktopPackage.build.files)) {
  throw new Error('configure-product: unsupported upstream application files configuration')
}
if (packagingTarget === 'windows') {
  desktopPackage.build.files.push(...windowsX64RuntimeExclusions)
}
pinNsisResources(desktopPackage)
applyWindowsInstallerGuard({
  windowsInstallerRoot,
  windowsInstallerIncludePath,
  desktopPackage,
  assertGeneratedPath,
})

/* --------------------------- 写回改写结果 --------------------------- */
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(
  verifyMacReleasePath,
  verifyMacRelease.replace(
    upstreamProductName,
    `productName: ${JSON.stringify(product.name)},`,
  ),
)
writeFileSync(mainPath, brandDesktopMain(main, product, legacyProductNames))
writeFileSync(
  indexPath,
  index
    .replace(upstreamRuntimeProductName, `productName: ${JSON.stringify(product.name)},`)
    .replace(upstreamWindowTitle, `windowTitle: ${JSON.stringify(product.name)},`),
)
writeFileSync(assistedMessagesPath, assistedMessages.replaceAll('DSH Desktop', product.name))
writeFileSync(
  releaseMacPath,
  releaseMac.replace(
    upstreamReleaseCheck,
    '  // TokensCowork product assembly owns the release quality gates before packaging.\n',
  ),
)
if (hasProductUpdatePlugin) {
  writeFileSync(desktopPatchPath, configureProductUpdates(
    readFileSync(desktopPatchPath, 'utf8'),
    product,
    repositoryMatch.groups.owner,
    repositoryMatch.groups.repo,
  ))
}
applyProductLogo({ productBrandRoot, stage, assertGeneratedPath })
process.stdout.write(`configure-product: ${product.name} ${product.version} (${product.appId})\n`)
