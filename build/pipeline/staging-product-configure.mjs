import { alignMacReleaseChecks, configureDesktopPackage } from '../modules/platform/desktop-packaging-overlay.mjs'
import { productStage } from './paths.mjs'
/* ====================================================================
 * 产品配置（打包前）
 * 在依赖安装完成的 staging 上注入品牌、安装器保护与打包参数。
 * 产品覆盖的具体加工逻辑按主题存放在 modules/ 目录；本文件只保留
 * 路径解析、读入副本、按序调用与写回。
 * ==================================================================== */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import {
  applyProductLogo,
  brandNativeCopy,
  assertBrandingAnchors,
  brandDesktopCertificate,
  brandDesktopClient,
  brandDesktopMain,
  brandDesktopProductIdentity,
  brandInstalledRuntimePrompts,
  upstreamProductName,
  upstreamWindowTitle,
} from '../modules/branding/branding-overlay.mjs'
import { configureProductUpdates } from '../modules/updates/updates-overlay.mjs'
import { applyWindowsInstallerGuard, pinNsisResources } from '../modules/platform/windows-installer-overlay.mjs'

/* ----------------------- 路径与产品清单 ----------------------- */
const root = resolve(import.meta.dirname, '..', '..')
const stage = productStage(root)
const productBrandRoot = resolve(root, 'build/modules/branding/assets')
const windowsInstallerRoot = resolve(root, 'build/modules/platform/assets/windows')
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
const productIdentityPath = resolve(desktopRoot, 'src', 'product-identity.ts')
const mainPath = resolve(desktopRoot, 'src', 'main.ts')
const indexPath = resolve(desktopRoot, 'src', 'index.ts')
const certificatePath = resolve(desktopRoot, 'src', 'lan-https-certificate.ts')
const assistedMessagesPath = resolve(desktopRoot, 'build', 'assistedMessages.yml')
const windowsInstallerIncludePath = resolve(desktopRoot, 'build', 'tokenscowork-upgrade-guard.nsh')
const desktopPatchPath = resolve(desktopRoot, 'cordis.patch.yml')
const titlebarPath = resolve(desktopRoot, 'src', 'client', 'DesktopFrameTitlebarView.tsx')
const settingsLocalesPath = resolve(desktopRoot, 'src', 'client', 'desktop-settings-locales.ts')

/* ----------------------- 读入待改写的副本 ----------------------- */
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
const verifyMacRelease = readFileSync(verifyMacReleasePath, 'utf8')
const releaseMac = readFileSync(releaseMacPath, 'utf8')
const productIdentity = readFileSync(productIdentityPath, 'utf8')
const main = readFileSync(mainPath, 'utf8')
const index = readFileSync(indexPath, 'utf8')
const certificate = readFileSync(certificatePath, 'utf8')
const assistedMessages = readFileSync(assistedMessagesPath, 'utf8')

/** 确保产品配置只改写 staging 副本。 */
function assertGeneratedPath(path) {
  if (path !== stage && !path.startsWith(`${stage}${sep}`)) {
    throw new Error(`configure-product: generated path escaped staging: ${path}`)
  }
}

/* --------------------------- 锚点校验 --------------------------- */
assertBrandingAnchors({ verifyMacRelease, productIdentity, main, index, certificate, assistedMessages })
const configuredMacRelease = alignMacReleaseChecks(releaseMac)
const clientBranding = brandDesktopClient({
  titlebar: readFileSync(titlebarPath, 'utf8'),
  locales: readFileSync(settingsLocalesPath, 'utf8'),
}, product.name)

/* --------------------- 原生界面可见文案品牌化 --------------------- */
// 原生对话框、托盘菜单、恢复窗口、系统通知与原生页面标题的可见文案
// 逐句携带上游品牌(重启确认框等直接示人)。这些文件只含显示字符串,
// 整体替换;身份/迁移逻辑里对上游名称的引用(安装探测等)不在此列,
// 不能盲替。上游不再携带品牌时锚定失败,中断装配待人工复查。
brandNativeCopy(desktopRoot, product.name)

/* ----------------------- electron-builder ----------------------- */
configureDesktopPackage(desktopPackage, product, packagingTarget)
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
writeFileSync(productIdentityPath, brandDesktopProductIdentity(productIdentity, product))
writeFileSync(mainPath, brandDesktopMain(main, legacyProductNames))
writeFileSync(certificatePath, brandDesktopCertificate(certificate, product.name))
writeFileSync(titlebarPath, clientBranding.titlebar)
writeFileSync(settingsLocalesPath, clientBranding.locales)
writeFileSync(
  indexPath,
  index
    .replace(upstreamWindowTitle, `windowTitle: ${JSON.stringify(product.name)},`),
)
writeFileSync(assistedMessagesPath, assistedMessages.replaceAll('DSH Desktop', product.name))
writeFileSync(
  releaseMacPath,
  configuredMacRelease,
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
brandInstalledRuntimePrompts({ stage, productName: product.name })
process.stdout.write(`configure-product: ${product.name} ${product.version} (${product.appId})\n`)
