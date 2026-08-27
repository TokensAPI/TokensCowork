import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const desktopRoot = resolve(root, '.build', 'desktop', 'dsh-plugin-desktop')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const product = manifest.product
const hasProductUpdatePlugin = manifest.plugins.some(
  plugin => plugin.id === 'tokens-version-updates' && plugin.enabledByDefault === true,
)
const desktopPackage = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))

function read(relativePath) {
  return readFileSync(resolve(desktopRoot, relativePath), 'utf8')
}

function readRuntimeClosure() {
  const lib = resolve(desktopRoot, 'lib')
  return readdirSync(lib, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => readFileSync(resolve(lib, entry.name), 'utf8'))
    .join('\n')
}

function requireText(content, expected, label) {
  if (!content.includes(expected)) {
    throw new Error(`verify-product-branding: ${label} is missing ${JSON.stringify(expected)}`)
  }
}

function rejectText(content, unexpected, label) {
  if (content.includes(unexpected)) {
    throw new Error(`verify-product-branding: ${label} retains ${JSON.stringify(unexpected)}`)
  }
}

if (desktopPackage.build?.appId !== product.appId) {
  throw new Error('verify-product-branding: packaged appId differs from product.json')
}
if (desktopPackage.build?.productName !== product.name) {
  throw new Error('verify-product-branding: packaged productName differs from product.json')
}
if (desktopPackage.build?.nsis?.guid !== product.windowsInstallerGuid) {
  throw new Error('verify-product-branding: NSIS upgrade identity differs from product.json')
}
if (desktopPackage.build?.nsis?.shortcutName !== product.name) {
  throw new Error('verify-product-branding: NSIS product configuration is incomplete')
}
if (desktopPackage.build?.nsis?.include !== 'build/tokenscowork-upgrade-guard.nsh') {
  throw new Error('verify-product-branding: NSIS upgrade guard is not configured')
}
// 卸载默认保留用户数据，而 deleteAppDataOnUninstall 是编译期开关，
// 写进安装包后运行期无法撤销，因此这里不允许它为真。
if (desktopPackage.build?.nsis?.deleteAppDataOnUninstall === true) {
  throw new Error('verify-product-branding: NSIS is configured to delete user data on uninstall')
}

const mainSource = read('src/main.ts')
const indexSource = read('src/index.ts')
const mainRuntime = read('lib/main.js')
const desktopRuntimeClosure = readRuntimeClosure()
const assistedMessages = read('build/assistedMessages.yml')
const windowsUpgradeGuard = read('build/tokenscowork-upgrade-guard.nsh')
const desktopPatch = read('cordis.patch.yml')

for (const [content, label] of [
  [mainSource, 'main source'],
  [mainRuntime, 'compiled main runtime'],
]) {
  requireText(content, product.name, label)
  requireText(content, product.appId, label)
  rejectText(content, 'ai.deepseek.dsh.desktop', label)
}

for (const [content, label] of [
  [indexSource, 'desktop shell source'],
  [desktopRuntimeClosure, 'compiled desktop shell runtime closure'],
]) {
  requireText(content, product.name, label)
  rejectText(content, 'DeepSeek Harness Desktop', label)
}

requireText(assistedMessages, product.name, 'assisted installer messages')
rejectText(assistedMessages, 'DSH Desktop', 'assisted installer messages')
requireText(windowsUpgradeGuard, 'customUnInstallCheck', 'Windows installer upgrade guard')
requireText(windowsUpgradeGuard, 'customRemoveFiles', 'Windows uninstaller upgrade guard')
requireText(windowsUpgradeGuard, 'SetErrorLevel 2', 'Windows installer failure handling')
requireText(mainSource, 'LEGACY_PRODUCT_NAMES', 'user-data migration source')
requireText(mainSource, 'migrateLegacyUserData()', 'user-data migration source')
requireText(mainSource, "app.setPath('userData', currentUserData)", 'user-data migration source')
rejectText(mainSource, "app.setPath('userData', legacyUserData)", 'user-data migration source')
for (const legacyName of product.legacyNames ?? []) {
  requireText(mainRuntime, legacyName, 'compiled legacy user-data migration')
}
requireText(desktopPackage.build?.nsis?.artifactName ?? '', `${product.name}-`, 'Windows installer name')
requireText(desktopPackage.build?.win?.artifactName ?? '', `${product.name}-`, 'Windows portable package name')
if (hasProductUpdatePlugin) {
  requireText(desktopPatch, `productName: ${product.name}`, 'product update configuration')
  requireText(desktopPatch, `githubRepo: ${product.repository.split('/')[1]}`, 'product update configuration')
}

process.stdout.write(
  `verify-product-branding: ${product.name} (${product.appId}) runtime and installer branding passed\n`,
)
