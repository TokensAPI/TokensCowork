/* ============================================================
 * 产品覆盖：品牌与视觉
 * ============================================================
 * 把上游 DSH Desktop 的产品名、窗口标题、安装器文案、App User
 * Model ID 和全套 Logo 替换为当前产品品牌，并为改名后的旧用户
 * 数据目录提供启动迁移。
 * 每个导出函数自带锚点守护：上游代码变动导致锚点失配时装配立即
 * 失败，等待人工复查，绝不静默漏掉覆盖。
 * ============================================================ */
import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

/* ------------------------- 上游品牌锚点 ------------------------- */
// Electron 的 userData 目录由 app.setName() 推导，而上游把产品名硬编码在这里。
// 不改写它，产品的宿主状态会继续写进上游品牌的目录。
export const upstreamMainProductName = "const PRODUCT_NAME = 'DSH Desktop'"
export const upstreamElectronImport = "import { app, crashReporter, dialog } from 'electron'"
export const upstreamRunProductName = `async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)`
export const upstreamAppUserModelId = "app.setAppUserModelId('ai.deepseek.dsh.desktop')"
export const upstreamRuntimeProductName = "productName: 'DSH Desktop',"
export const upstreamWindowTitle = "windowTitle: 'DeepSeek Harness Desktop',"
export const upstreamProductName = "productName: 'DSH Desktop',"

/**
 * 校验全部品牌锚点仍然存在；任何一个失配都立即中断装配。
 * @param copies - 各 staging 副本的当前内容。
 */
export function assertBrandingAnchors({ verifyMacRelease, main, index, assistedMessages }) {
  if (!verifyMacRelease.includes(upstreamProductName)) {
    throw new Error('configure-product: cannot locate macOS release product name')
  }
  if (!main.includes(upstreamMainProductName)) {
    throw new Error('configure-product: cannot locate desktop runtime product name')
  }
  if (!main.includes(upstreamElectronImport) || !main.includes(upstreamRunProductName)) {
    throw new Error('configure-product: cannot locate desktop user-data migration anchors')
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
}

/**
 * 改写 Electron 主进程：产品名、旧用户数据迁移与 App User Model ID。
 * 改名发布后旧目录仍在时按 legacyNames 顺序迁移（或降级沿用），保证
 * 用户数据跨品牌无缝保留。
 * @param main - staging 副本 src/main.ts 的完整内容。
 * @param product - product.json 的 product 段。
 * @param legacyProductNames - 迁移候选的历史产品名列表。
 * @returns 改写后的 main.ts 内容。
 */
export function brandDesktopMain(main, product, legacyProductNames) {
  return main
    .replace(
      upstreamElectronImport,
      `${upstreamElectronImport}\nimport { existsSync, renameSync } from 'node:fs'`,
    )
    .replace(upstreamMainProductName, `const PRODUCT_NAME = ${JSON.stringify(product.name)}`)
    .replace(
      `const PRODUCT_NAME = ${JSON.stringify(product.name)}`,
      `const PRODUCT_NAME = ${JSON.stringify(product.name)}\nconst LEGACY_PRODUCT_NAMES = ${JSON.stringify(legacyProductNames)} as const`,
    )
    .replace(
      upstreamRunProductName,
      `function migrateLegacyUserData(): void {
  const currentUserData = app.getPath('userData')
  if (existsSync(currentUserData)) return
  const appData = app.getPath('appData')
  for (const legacyName of LEGACY_PRODUCT_NAMES) {
    const legacyUserData = join(appData, legacyName)
    if (!existsSync(legacyUserData)) continue
    try {
      renameSync(legacyUserData, currentUserData)
    } catch {
      app.setPath('userData', legacyUserData)
    }
    return
  }
}

async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)
  migrateLegacyUserData()`,
    )
    .replace(upstreamAppUserModelId, `app.setAppUserModelId(${JSON.stringify(product.appId)})`)
}

/**
 * 用同一张正式 Logo 覆盖产品图标入口；除必要尺寸和格式外不改图形。
 * @param options.productBrandRoot - 仓库内品牌资产目录。
 * @param options.stage - staging 根目录。
 * @param options.assertGeneratedPath - staging 越界守护。
 */
export function applyProductLogo({ productBrandRoot, stage, assertGeneratedPath }) {
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
    resolve(stage, 'deepseek-harness', 'apps', 'web', 'public', 'tokenscowork-logo.png'),
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
