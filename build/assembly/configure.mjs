import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const stage = resolve(root, '.build', 'desktop')
const productBrandRoot = resolve(import.meta.dirname, 'assets', 'brand')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8')).product
const desktopPackagePath = resolve(root, '.build', 'desktop', 'dsh-plugin-desktop', 'package.json')
const verifyMacReleasePath = resolve(
  root,
  '.build',
  'desktop',
  'dsh-plugin-desktop',
  'scripts',
  'verify-mac-release.ts',
)
const releaseMacPath = resolve(
  root,
  '.build',
  'desktop',
  'dsh-plugin-desktop',
  'scripts',
  'release-mac.ts',
)
const mainPath = resolve(
  root,
  '.build',
  'desktop',
  'dsh-plugin-desktop',
  'src',
  'main.ts',
)
const indexPath = resolve(
  root,
  '.build',
  'desktop',
  'dsh-plugin-desktop',
  'src',
  'index.ts',
)
const assistedMessagesPath = resolve(
  root,
  '.build',
  'desktop',
  'dsh-plugin-desktop',
  'build',
  'assistedMessages.yml',
)
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
const verifyMacRelease = readFileSync(verifyMacReleasePath, 'utf8')
const releaseMac = readFileSync(releaseMacPath, 'utf8')
const main = readFileSync(mainPath, 'utf8')
const index = readFileSync(indexPath, 'utf8')
const assistedMessages = readFileSync(assistedMessagesPath, 'utf8')
// Electron 的 userData 目录由 app.setName() 推导，而上游把产品名硬编码在这里。
// 不改写它，产品的宿主状态会继续写进上游品牌的目录。
const upstreamMainProductName = "const PRODUCT_NAME = 'DSH Desktop'"
const upstreamAppUserModelId = "app.setAppUserModelId('ai.deepseek.dsh.desktop')"
const upstreamRuntimeProductName = "productName: 'DSH Desktop',"
const upstreamWindowTitle = "windowTitle: 'DeepSeek Harness Desktop',"
const upstreamProductName = "productName: 'DSH Desktop',"
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

/** 用同一张正式 Logo 覆盖产品图标入口；除必要尺寸和格式外不改图形。 */
function applyProductLogo() {
  const requiredAssets = [
    resolve(productBrandRoot, 'app-icon.png'),
    resolve(productBrandRoot, 'logo-mark.png'),
    resolve(productBrandRoot, 'logo-mark.svg'),
    resolve(productBrandRoot, 'generate-tray-icons.mjs'),
    resolve(productBrandRoot, 'client', 'FishLogo.tsx'),
  ]
  for (const source of requiredAssets) {
    if (!existsSync(source)) {
      throw new Error(`configure-product: product Logo asset is missing: ${source}`)
    }
  }

  const desktopBuildRoot = resolve(stage, 'dsh-plugin-desktop', 'build')
  const outputs = [
    resolve(desktopBuildRoot, 'app-icon.png'),
    resolve(desktopBuildRoot, 'logo-mark.png'),
    resolve(desktopBuildRoot, 'tray-icon.svg'),
    resolve(stage, 'dsh-plugin-desktop', 'scripts', 'generate-tray-icons.mjs'),
    resolve(stage, 'deepseek-harness', 'apps', 'web', 'public', 'favicon.svg'),
    resolve(stage, 'deepseek-harness', 'apps', 'web', 'public', 'tokensharness-logo.png'),
    resolve(
      stage,
      'deepseek-harness',
      'packages',
      'client',
      'ui-primitives',
      'src',
      'FishLogo.tsx',
    ),
  ]
  for (const path of outputs) assertGeneratedPath(path)

  cpSync(resolve(productBrandRoot, 'app-icon.png'), outputs[0])
  cpSync(resolve(productBrandRoot, 'logo-mark.png'), outputs[1])
  cpSync(resolve(productBrandRoot, 'logo-mark.svg'), outputs[2])
  cpSync(resolve(productBrandRoot, 'generate-tray-icons.mjs'), outputs[3])
  cpSync(resolve(productBrandRoot, 'logo-mark.svg'), outputs[4])
  cpSync(resolve(productBrandRoot, 'logo-mark.png'), outputs[5])
  cpSync(resolve(productBrandRoot, 'client', 'FishLogo.tsx'), outputs[6])

  // 删除上游派生图，后续 build 会从正式 Logo 重新按尺寸生成。
  for (const filename of [
    'app-icon-mac.png',
    'tray-iconTemplate.png',
    'tray-iconTemplate@2x.png',
    'tray-icon-blue.png',
    'tray-icon-blue@1.25x.png',
    'tray-icon-blue@1.5x.png',
    'tray-icon-blue@2x.png',
  ]) {
    rmSync(resolve(desktopBuildRoot, filename), { force: true })
  }
}

if (!verifyMacRelease.includes(upstreamProductName)) {
  throw new Error('configure-product: cannot locate macOS release product name')
}
if (!releaseMac.includes(upstreamReleaseCheck)) {
  throw new Error('configure-product: cannot locate redundant macOS release check')
}
if (!main.includes(upstreamMainProductName)) {
  throw new Error('configure-product: cannot locate desktop runtime product name')
}
if (!main.includes(upstreamAppUserModelId)) {
  throw new Error('configure-product: cannot locate Windows App User Model ID')
}
if (!index.includes(upstreamRuntimeProductName) || !index.includes(upstreamWindowTitle)) {
  throw new Error('configure-product: cannot locate desktop shell branding')
}
if (!assistedMessages.includes('DSH Desktop')) {
  throw new Error('configure-product: cannot locate assisted installer branding')
}

desktopPackage.version = product.version
desktopPackage.build.appId = product.appId
desktopPackage.build.productName = product.name
desktopPackage.build.nsis.shortcutName = product.name
desktopPackage.build.nsis.artifactName = `${product.name}-\${version}-\${arch}-Setup.\${ext}`
// NSIS 3.12 provides long-path support, but its 1.2.1 bundle ships an ANSI
// nsisunz.dll in the Unicode plugin directory. Keep the new compiler and use
// the previously verified Unicode plugin resources for ZIP extraction.
desktopPackage.build.nsis.customNsisResources = {
  url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z',
  checksum: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103',
  version: '3.4.1',
}

writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(
  verifyMacReleasePath,
  verifyMacRelease.replace(
    upstreamProductName,
    `productName: ${JSON.stringify(product.name)},`,
  ),
)
writeFileSync(
  mainPath,
  main
    .replace(upstreamMainProductName, `const PRODUCT_NAME = ${JSON.stringify(product.name)}`)
    .replace(upstreamAppUserModelId, `app.setAppUserModelId(${JSON.stringify(product.appId)})`),
)
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
    '  // TokensHarness product assembly owns the release quality gates before packaging.\n',
  ),
)
applyProductLogo()
process.stdout.write(`configure-product: ${product.name} ${product.version} (${product.appId})\n`)
