// Desktop 源码、产品身份与补丁配置；不操作已安装依赖或派生图标。
import { replaceOnce } from '../../pipeline/anchors.mjs'

const upstreamIdentityProductName = "productName: 'DSH Desktop',"
const upstreamIdentityAppId = "appId: 'ai.deepseek.dsh.desktop',"
// Electron 的 userData 目录由 app.setName() 推导。覆盖身份后仍需在首次读取
// userData 前迁移历史产品目录，避免升级时丢失宿主状态。
const upstreamMainProductName = 'const PRODUCT_NAME = DESKTOP_PRODUCT_NAME'
const upstreamNodeCryptoImport = "import { randomUUID } from 'node:crypto'"
const upstreamRunProductName = `async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)`
const upstreamRuntimeProductName = 'productName: DESKTOP_PRODUCT_NAME,'
const upstreamWindowTitle = "windowTitle: 'DeepSeek Harness Desktop',"
const upstreamProductName = "productName: 'DSH Desktop',"
const upstreamCertificateCommonName = "const CA_COMMON_NAME = 'DeepSeek Harness Desktop Local CA'"

const replaceAnchor = (source, before, after, label) => replaceOnce(source, before, after, label)

/**
 * 覆盖 Stable Desktop 的唯一产品身份来源。main.ts、Profile 通道检测和
 * Windows App User Model ID 都从这里读取，避免各处品牌配置发生漂移。
 */
export function brandDesktopProductIdentity(productIdentity, product) {
  return replaceAnchor(replaceAnchor(productIdentity, upstreamIdentityProductName,
    `productName: ${JSON.stringify(product.name)},`, 'stable product name'),
    upstreamIdentityAppId, `appId: ${JSON.stringify(product.appId)},`, 'stable app id')
}

/** 覆盖局域网 HTTPS 本地 CA 的可见产品名。 */
export function brandDesktopCertificate(certificate, productName) {
  return replaceAnchor(certificate,
    upstreamCertificateCommonName,
    `const CA_COMMON_NAME = ${JSON.stringify(`${productName} Local CA`)}`,
    'local certificate name',
  )
}

/** 验收完整运行时闭包：本地 CA 常量可能在延迟加载的 chunk 中。 */
export function verifyDesktopCertificateBranding(runtimeClosure, productName) {
  if (!runtimeClosure.includes(`${productName} Local CA`)) {
    throw new Error('Desktop runtime is missing the product local certificate brand')
  }
  if (runtimeClosure.includes('DeepSeek Harness Desktop Local CA')) {
    throw new Error('Desktop runtime retains upstream local certificate branding')
  }
}

/** 顶部栏和桌面设置中的可见名称使用产品品牌。 */
export function brandDesktopClient({ titlebar, locales }, productName) {
  const brand = '<span className="dshDesktopFrameProduct">DSH Desktop</span>'
  if (titlebar.split(brand).length !== 2) {
    throw new Error('configure-product: cannot locate Desktop titlebar branding')
  }
  if (!locales.includes("title: 'DSH Desktop 设置'")) {
    throw new Error('configure-product: cannot locate Desktop settings branding')
  }
  return {
    titlebar: titlebar.replace(brand, `<span className="dshDesktopFrameProduct">{${JSON.stringify(productName)}}</span>`),
    locales: locales.replaceAll('DSH Desktop', productName),
  }
}

/**
 * 改写 Electron 主进程：产品名、旧用户数据迁移与 App User Model ID。
 * 改名发布后旧目录仍在时按 legacyNames 顺序迁移。跨卷拷贝先进入临时
 * 目录，再改名交付；迁移失败时保留旧目录并报错，避免启动空的用户状态。
 * @param main - staging 副本 src/main.ts 的完整内容。
 * @param legacyProductNames - 迁移候选的历史产品名列表。
 * @returns 改写后的 main.ts 内容。
 */
export function brandDesktopMain(main, legacyProductNames) {
  main = replaceAnchor(main, upstreamNodeCryptoImport,
    `${upstreamNodeCryptoImport}\nimport { cpSync, renameSync, rmSync } from 'node:fs'`, 'migration imports')
  main = replaceAnchor(main, upstreamMainProductName,
    `${upstreamMainProductName}\nconst LEGACY_PRODUCT_NAMES = ${JSON.stringify(legacyProductNames)} as const`, 'migration names')
  return replaceAnchor(main, upstreamRunProductName,
      `function migrateLegacyUserData(): void {
  // Electron reads Windows known folders independently of the APPDATA environment variable.
  const devAppData = app.isPackaged ? undefined : process.env.TOKENS_COWORK_DEV_APP_DATA
  if (devAppData) app.setPath('appData', devAppData)
  const appData = app.getPath('appData')
  const currentUserData = join(appData, PRODUCT_NAME)
  if (!existsSync(currentUserData)) {
    for (const legacyName of LEGACY_PRODUCT_NAMES) {
      const legacyUserData = join(appData, legacyName)
      if (!existsSync(legacyUserData)) continue
      try {
        renameSync(legacyUserData, currentUserData)
      } catch {
        const temporaryUserData = join(appData, \`\${PRODUCT_NAME}-migration-\${randomUUID()}\`)
        try {
          cpSync(legacyUserData, temporaryUserData, { recursive: true, errorOnExist: true, force: false })
          renameSync(temporaryUserData, currentUserData)
        } catch (cause) {
          rmSync(temporaryUserData, { recursive: true, force: true })
          throw new Error(\`\${PRODUCT_NAME}: user data migration failed; the original directory was retained\`, { cause })
        }
      }
      break
    }
  }
  app.setPath('userData', currentUserData)
  if (devAppData) app.setPath('sessionData', currentUserData)
}

async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)
  migrateLegacyUserData()`,
    'migration bootstrap')
}

/**
 * 系统提示词与界面品牌的补丁层覆盖：停用上游官方 UI 品牌插件，把
 * 系统提示词身份行换成产品品牌。只换品牌不加规则——persona 一句话，
 * 工具说明与运行时上下文保持上游原样。
 * @param desktopPatch - staging 副本 cordis.patch.yml 的当前内容。
 * @param productName - 产品名（来自 product.json）。
 * @returns 追加品牌覆盖条目后的补丁内容。
 */
export function brandDesktopPatch(desktopPatch, productName) {
  if (desktopPatch.includes('# 产品覆盖：停用上游官方 UI 品牌。')) {
    throw new Error('branding: Desktop patch branding was applied twice')
  }
  return desktopPatch
    + '\n\n# 产品覆盖：停用上游官方 UI 品牌。\n'
    + '- id: ui-brand-official\n  disabled: true'
    + '\n\n# 产品覆盖：系统提示词身份行使用产品品牌。\n'
    + '- id: system-prompt\n'
    + '  config:\n'
    + '    includeHarnessIdentity: false\n'
    + `    persona: You are the AI agent inside ${productName}.`
    // DSH 0.2.1 新增的 harness-dev-context 面向「检查或扩展承载本 GUI 的 harness」的开发者，
    // 它自己往系统提示词里加两段写死上游品牌的内容（"DeepSeek Harness Web GUI"、
    // "DeepSeek Harness implementation checkout" 及其路径与 URL）。system-prompt 的
    // persona 与 includeHarnessIdentity 管不到它们，于是产品里又出现了上游品牌
    // （2026-10-27 用户实测：模型自称运行在 "DeepSeek Harness Web GUI"）。本产品不开发
    // harness 本身，整条停用。
    + '\n\n# 产品覆盖：停用面向 harness 开发者的提示词上下文。\n'
    + '- id: harness-dev-context\n  disabled: true'
}

/** 仅替换显示文案；安装身份和历史数据路径不做全局文本替换。 */
export const nativeCopyPaths = [
  ['src', 'native-dialog-copy.ts'],
  ['src', 'tray-locale.ts'],
  ['src', 'recovery-copy.ts'],
  ['src', 'notifications.ts'],
  ['src', 'client', 'directory-picker.ts'],
  ['src', 'native-ui', 'desktop-dialog.html'],
  ['src', 'native-ui', 'recovery.html'],
  ['src', 'native-ui', 'setup-wizard.html'],
  ['src', 'native-ui', 'compatibility-chrome.html'],
  ['src', 'native-ui', 'compatibility-chrome', 'main.tsx'],
  ['src', 'setup-wizard-copy.ts'],
  ['src', 'remote-control-offer.ts'],
  ['src', 'desktop-terminal.ts'],
  ['src', 'desktop-plugins.ts'],
  ['src', 'desktop-boot-recovery.ts'],
  ['src', 'desktop-data-directory.ts'],
  ['src', 'windows-volume-diagnostics.ts'],
  ['src', 'workspace-admission.ts'],
  ['src', 'update-lifecycle.ts'],
  ['src', 'bin.ts'],
]
/** 原生界面文案整体替换上游品牌；已是产品品牌时保持不变。 */
export function brandNativeCopyText(source, path, productName) {
  if (!/DSH Desktop|DeepSeek Harness|DSH Terminal|DSH 终端/u.test(source)) {
    if (source.includes(productName)) return source
    throw new Error(`${path} no longer carries upstream desktop branding`)
  }
  return source.replaceAll('DSH Desktop', productName).replaceAll('DeepSeek Harness', productName)
    .replaceAll('DSH Terminal', `${productName} Terminal`).replaceAll('DSH 终端', `${productName} 终端`)
}

/** macOS 验收的产品名属于品牌策略；架构和签名逻辑仍由 platform 负责。 */
export function brandMacReleaseVerification(source, productName) {
  return replaceAnchor(source, upstreamProductName, `productName: ${JSON.stringify(productName)},`, 'macOS verification identity')
}

/** Profile 启动验收按品牌化后的托盘文案查找终端入口（原生文案由 brandNativeCopyText 替换）。 */
export function brandProfileBootTerminalCheck(source, productName) {
  return replaceAnchor(source, "item.label() === 'Open DSH Terminal'",
    `item.label() === ${JSON.stringify(`Open ${productName} Terminal`).replaceAll('"', "'")}`, 'profile terminal tray check')
}

/**
 * Desktop 源码中的产品身份、窗口标题、证书名、客户端文案、安装器提示与旧数据迁移。
 * @param input - { identity, main, index, certificate, titlebar, settingsLocales, assistedMessages } 文本。
 * @param product - product.json 的 product 段。
 * @returns 同结构的品牌化结果。
 */
export function brandDesktopSources(input, product) {
  const legacyNames = product.legacyNames ?? []
  if (!Array.isArray(legacyNames) || legacyNames.some(name => typeof name !== 'string'
    || name.trim() === '' || name === '.' || name === '..' || /[\\/]/u.test(name))) {
    throw new Error('branding: legacyNames must contain safe directory names')
  }
  const client = brandDesktopClient({ titlebar: input.titlebar, locales: input.settingsLocales }, product.name)
  if (!input.index.includes(upstreamRuntimeProductName)) throw new Error('branding: Desktop runtime identity changed')
  if (!input.assistedMessages.includes('DSH Desktop')) throw new Error('branding: assisted installer identity changed')
  return {
    identity: brandDesktopProductIdentity(input.identity, product),
    main: brandDesktopMain(input.main, legacyNames),
    index: replaceAnchor(input.index, upstreamWindowTitle, `windowTitle: ${JSON.stringify(product.name)},`, 'window title').replaceAll('DSH Desktop', product.name),
    certificate: brandDesktopCertificate(input.certificate, product.name),
    titlebar: client.titlebar,
    settingsLocales: client.locales,
    assistedMessages: input.assistedMessages.replaceAll('DSH Desktop', product.name),
  }
}

/**
 * 侧栏底部已登录账号行与上方“插件市场”行对齐：上游账号菜单（登录插件照搬）用 24px 头像和 6px 左边距，
 * 头像中心与文字起点分别比 16px 图标的市场行偏右 4px、8px。只追加已登录且展开时的规则。
 */
export function alignSidebarAccountRow(source) {
  return replaceAnchor(source, "      '.tkl-label{",
    "      '.tkl-trigger[data-collapsed=false][data-signed-out=false]{padding-left:4px;gap:6px}',\n"
    + "      '.tkl-trigger[data-collapsed=false][data-signed-out=false] .tkl-avatar{width:20px;height:20px;font-size:11px}',\n"
    + "      '.tkl-label{", 'sidebar account row styles')
}
