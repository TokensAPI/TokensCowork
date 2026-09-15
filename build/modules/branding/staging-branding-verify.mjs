import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { productStage } from '../../pipeline/paths.mjs'
import { hideUpstreamCloudEntry, nativeCopyPaths, verifyDesktopCertificateBranding } from './branding-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const desktopRoot = resolve(productStage(root), 'dsh-plugin-desktop')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const product = manifest.product
const cloudClient = readFileSync(resolve(desktopRoot, 'node_modules/@agents-anywhere/dsh-bridge-next/lib/client.js'), 'utf8')
if (hideUpstreamCloudEntry(cloudClient) !== cloudClient) {
  throw new Error('verify-product-branding: upstream Agents Anywhere sidebar entry is still registered')
}
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
if (desktopPackage.description !== `${product.name} desktop application`) {
  throw new Error('verify-product-branding: shortcut/application description differs from product brand')
}
const marketClient = readFileSync(resolve(desktopRoot, '../dsh-community-market/lib/client.js'), 'utf8')
for (const oldBrand of ['DSH Desktop', 'DeepSeek Harness', 'DSH Terminal', 'DSH 终端']) {
  rejectText(marketClient, oldBrand, 'compiled market client')
}
requireText(marketClient, `重启 ${product.name}`, 'compiled market restart message')
rejectText(read('node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js'),
  'DSH Desktop', 'installed directory picker error copy')
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
const productIdentitySource = read('src/product-identity.ts')
const indexSource = read('src/index.ts')
const certificateSource = read('src/lan-https-certificate.ts')
const mainRuntime = read('lib/main.js')
const desktopRuntimeClosure = readRuntimeClosure()
const assistedMessages = read('build/assistedMessages.yml')
const windowsUpgradeGuard = read('build/tokenscowork-upgrade-guard.nsh')
const desktopPatch = read('cordis.patch.yml')

requireText(productIdentitySource, `productName: ${JSON.stringify(product.name)}`, 'product identity source')
requireText(productIdentitySource, `appId: ${JSON.stringify(product.appId)}`, 'product identity source')
rejectText(productIdentitySource, "productName: 'DSH Desktop',", 'stable product identity source')
rejectText(productIdentitySource, "appId: 'ai.deepseek.dsh.desktop',", 'stable product identity source')
requireText(desktopRuntimeClosure, product.name, 'compiled desktop runtime closure')
requireText(desktopRuntimeClosure, product.appId, 'compiled desktop runtime closure')
requireText(certificateSource, `${product.name} Local CA`, 'local certificate source')
rejectText(certificateSource, 'DeepSeek Harness Desktop Local CA', 'local certificate source')
verifyDesktopCertificateBranding(desktopRuntimeClosure, product.name)

requireText(indexSource, product.name, 'desktop shell source')
rejectText(indexSource, 'DeepSeek Harness Desktop', 'desktop shell source')
requireText(desktopRuntimeClosure, product.name, 'compiled desktop shell runtime closure')
rejectText(read('src/client/DesktopFrameTitlebarView.tsx'), 'DSH Desktop', 'desktop titlebar source')
// 原生对话框/托盘/恢复/通知文案与原生页面标题:configure 阶段整体替换,
// 这里兜底防止上游 pin 更新后新增的品牌串漏网。
for (const segments of nativeCopyPaths) {
  const nativeCopyPath = segments.join('/')
  rejectText(read(nativeCopyPath), 'DSH Desktop', nativeCopyPath)
  rejectText(read(nativeCopyPath), 'DeepSeek Harness', nativeCopyPath)
}
rejectText(read('src/client/desktop-settings-locales.ts'), 'DSH Desktop', 'desktop settings source')
requireText(read('lib/client.js'), `${product.name} 设置`, 'compiled desktop settings')
rejectText(read('lib/client.js'), 'DSH Desktop 设置', 'compiled desktop settings')
requireText(read('node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'),
  `const productTitle = ${JSON.stringify(product.name)};`, 'installed client document title')
const htmlTitle = product.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
requireText(read('node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'),
  `<title>${htmlTitle}</title>`, 'installed frontend initial title')
requireText(read('lib/native-ui/compatibility-chrome.html'), `<title>${htmlTitle}</title>`, 'compiled compatibility chrome title')

requireText(assistedMessages, product.name, 'assisted installer messages')
rejectText(assistedMessages, 'DSH Desktop', 'assisted installer messages')
requireText(windowsUpgradeGuard, 'customUnInstallCheck', 'Windows installer upgrade guard')
requireText(windowsUpgradeGuard, 'customRemoveFiles', 'Windows uninstaller upgrade guard')
requireText(windowsUpgradeGuard, 'SetErrorLevel 2', 'Windows installer failure handling')
requireText(mainSource, 'LEGACY_PRODUCT_NAMES', 'user-data migration source')
requireText(mainSource, 'migrateLegacyUserData()', 'user-data migration source')
requireText(mainSource, "app.setPath('userData', currentUserData)", 'user-data migration source')
requireText(mainSource, 'DESKTOP_PRODUCT_NAME', 'product identity import')
requireText(mainSource, 'DESKTOP_APP_ID', 'application identity import')
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
