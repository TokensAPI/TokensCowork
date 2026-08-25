import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const desktopRoot = resolve(root, '.build', 'desktop', 'dsh-plugin-desktop')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8')).product
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
if (desktopPackage.build?.nsis?.shortcutName !== product.name) {
  throw new Error('verify-product-branding: NSIS product configuration is incomplete')
}
if (desktopPackage.build?.nsis?.include !== 'build/tokensharness-upgrade-guard.nsh') {
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
const windowsUpgradeGuard = read('build/tokensharness-upgrade-guard.nsh')

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

process.stdout.write(
  `verify-product-branding: ${product.name} (${product.appId}) runtime and installer branding passed\n`,
)
