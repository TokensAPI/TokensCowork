import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
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
process.stdout.write(`configure-product: ${product.name} ${product.version} (${product.appId})\n`)
