/* ============================================================
 * 产品覆盖：品牌与视觉
 * ============================================================
 * 把上游 DSH Desktop 的产品名、窗口标题、安装器文案、App User
 * Model ID 和全套 Logo 替换为当前产品品牌，并为改名后的旧用户
 * 数据目录提供启动迁移。
 * 每个导出函数自带锚点守护：上游代码变动导致锚点失配时装配立即
 * 失败，等待人工复查，绝不静默漏掉覆盖。
 * ============================================================ */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* ------------------------- 上游品牌锚点 ------------------------- */
// 新版上游将 Stable/Beta 的产品身份集中在 product-identity.ts。产品构建只
// 覆盖 Stable 身份；Beta 继续作为另一个上游发行通道供 Profile 冲突检测。
export const upstreamIdentityProductName = "productName: 'DSH Desktop',"
export const upstreamIdentityAppId = "appId: 'ai.deepseek.dsh.desktop',"
// Electron 的 userData 目录由 app.setName() 推导。覆盖身份后仍需在首次读取
// userData 前迁移历史产品目录，避免升级时丢失宿主状态。
export const upstreamMainProductName = 'const PRODUCT_NAME = DESKTOP_PRODUCT_NAME'
export const upstreamNodeCryptoImport = "import { randomUUID } from 'node:crypto'"
export const upstreamRunProductName = `async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)`
export const upstreamRuntimeProductName = "productName: 'DSH Desktop',"
export const upstreamWindowTitle = "windowTitle: 'DeepSeek Harness Desktop',"
export const upstreamProductName = "productName: 'DSH Desktop',"
const upstreamCertificateCommonName = "const CA_COMMON_NAME = 'DeepSeek Harness Desktop Local CA'"
const upstreamWindowsBrandColor = "const BRAND_BLUE = '#4D6BFE'\n"
const upstreamWindowsMarkPath = "const markPath = join(packageRoot, 'build', 'tray-icon.svg')"
const upstreamWindowsSmallFrameLoader = `async function loadSmallFrameArtwork() {
  const source = await readFile(markPath, 'utf8')
  if (!source.includes(\`fill="\${BRAND_BLUE}"\`) || /<style\\b/iu.test(source)) {
    throw new Error(\`generate-windows-app-icon: tray-icon.svg must use the fixed brand color \${BRAND_BLUE}\`)
  }
  const mark = source
    .replace(/^<svg[^>]*>\\s*/u, '')
    .replace(/<\\/svg>\\s*$/u, '')
    .replaceAll(BRAND_BLUE, '#000000')
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">'
    + '<rect width="50" height="50" rx="11" fill="#FFFFFF"/>'
    + \`<g transform="translate(5 5) scale(0.8)">\${mark}</g>\`
    + '</svg>',
  )
}`

/**
 * 校验全部品牌锚点仍然存在；任何一个失配都立即中断装配。
 * @param copies - 各 staging 副本的当前内容。
 */
export function assertBrandingAnchors({
  verifyMacRelease,
  productIdentity,
  main,
  index,
  certificate,
  assistedMessages,
}) {
  if (!verifyMacRelease.includes(upstreamProductName)) {
    throw new Error('configure-product: cannot locate macOS release product name')
  }
  if (!productIdentity.includes(upstreamIdentityProductName)
    || !productIdentity.includes(upstreamIdentityAppId)) {
    throw new Error('configure-product: cannot locate stable desktop product identity')
  }
  if (!main.includes(upstreamMainProductName)
    || !main.includes(upstreamNodeCryptoImport)
    || !main.includes(upstreamRunProductName)) {
    throw new Error('configure-product: cannot locate desktop user-data migration anchors')
  }
  if (!index.includes(upstreamRuntimeProductName) || !index.includes(upstreamWindowTitle)) {
    throw new Error('configure-product: cannot locate desktop shell branding')
  }
  if (!certificate.includes(upstreamCertificateCommonName)) {
    throw new Error('configure-product: cannot locate desktop local certificate branding')
  }
  if (!assistedMessages.includes('DSH Desktop')) {
    throw new Error('configure-product: cannot locate assisted installer branding')
  }
}

/**
 * 覆盖 Stable Desktop 的唯一产品身份来源。main.ts、Profile 通道检测和
 * Windows App User Model ID 都从这里读取，避免各处品牌配置发生漂移。
 */
export function brandDesktopProductIdentity(productIdentity, product) {
  return productIdentity
    .replace(upstreamIdentityProductName, `productName: ${JSON.stringify(product.name)},`)
    .replace(upstreamIdentityAppId, `appId: ${JSON.stringify(product.appId)},`)
}

/** 覆盖局域网 HTTPS 本地 CA 的可见产品名。 */
export function brandDesktopCertificate(certificate, productName) {
  return certificate.replace(
    upstreamCertificateCommonName,
    `const CA_COMMON_NAME = ${JSON.stringify(`${productName} Local CA`)}`,
  )
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
 * 改名发布后旧目录仍在时按 legacyNames 顺序迁移（或降级沿用），保证
 * 用户数据跨品牌无缝保留。
 * @param main - staging 副本 src/main.ts 的完整内容。
 * @param legacyProductNames - 迁移候选的历史产品名列表。
 * @returns 改写后的 main.ts 内容。
 */
export function brandDesktopMain(main, legacyProductNames) {
  return main
    .replace(
      upstreamNodeCryptoImport,
      `${upstreamNodeCryptoImport}\nimport { cpSync, existsSync, renameSync } from 'node:fs'`,
    )
    .replace(
      upstreamMainProductName,
      `${upstreamMainProductName}\nconst LEGACY_PRODUCT_NAMES = ${JSON.stringify(legacyProductNames)} as const`,
    )
    .replace(
      upstreamRunProductName,
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
        try {
          cpSync(legacyUserData, currentUserData, { recursive: true, errorOnExist: false })
        } catch {}
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
    )
}

/**
 * 新版上游用官方单色鲸鱼生成 Windows 小尺寸 ICO 帧。TokensCowork 的
 * 正式标志是自带色彩的 PNG，直接使用该小图资产，避免强行套用上游蓝色。
 */
function brandWindowsIconGenerator(generator) {
  if (!generator.includes(upstreamWindowsBrandColor)
    || !generator.includes(upstreamWindowsMarkPath)
    || !generator.includes(upstreamWindowsSmallFrameLoader)) {
    throw new Error('configure-product: cannot locate Windows small-frame icon anchors')
  }
  return generator
    .replace(upstreamWindowsBrandColor, '')
    .replace(
      upstreamWindowsMarkPath,
      "const markPath = join(packageRoot, 'build', 'logo-mark.png')",
    )
    .replace(
      upstreamWindowsSmallFrameLoader,
      `async function loadSmallFrameArtwork() {
  return await readFile(markPath)
}`,
    )
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
  const windowsIconGeneratorPath = resolve(
    stage,
    'dsh-plugin-desktop',
    'scripts',
    'generate-windows-app-icon.mjs',
  )
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
  assertGeneratedPath(windowsIconGeneratorPath)

  cpSync(resolve(productBrandRoot, 'app-icon.png'), outputs[0])
  cpSync(resolve(productBrandRoot, 'logo-mark.png'), outputs[1])
  cpSync(resolve(productBrandRoot, 'logo-mark.svg'), outputs[2])
  cpSync(resolve(productBrandRoot, 'generate-tray-icons.mjs'), outputs[3])
  cpSync(resolve(productBrandRoot, 'logo-mark.svg'), outputs[4])
  cpSync(resolve(productBrandRoot, 'logo-mark.png'), outputs[5])
  cpSync(resolve(productBrandRoot, 'client', 'FishLogo.tsx'), outputs[6])
  writeFileSync(
    windowsIconGeneratorPath,
    brandWindowsIconGenerator(readFileSync(windowsIconGeneratorPath, 'utf8')),
  )

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

/**
 * 系统提示词与界面品牌的补丁层覆盖：停用上游官方 UI 品牌插件，把
 * 系统提示词身份行换成产品品牌。只换品牌不加规则——persona 一句话，
 * 工具说明与运行时上下文保持上游原样。
 * @param desktopPatch - staging 副本 cordis.patch.yml 的当前内容。
 * @param productName - 产品名（来自 product.json）。
 * @returns 追加品牌覆盖条目后的补丁内容。
 */
export function brandDesktopPatch(desktopPatch, productName) {
  return desktopPatch
    + '\n\n# 产品覆盖：停用上游官方 UI 品牌。\n'
    + '- id: ui-brand-official\n  disabled: true'
    + '\n\n# 产品覆盖：系统提示词身份行使用产品品牌。\n'
    + '- id: system-prompt\n'
    + '  config:\n'
    + '    includeHarnessIdentity: false\n'
    + `    persona: You are the AI agent inside ${productName}.`
}

/**
 * 品牌化依赖安装后的运行时文本：系统提示词的动态注入段与 agent 预设
 * persona 分布在已安装的 node_modules（编译产物与预设 YAML）里，装配
 * 源码覆盖够不着，须在 yarn install 之后改写。逐处带出现次数校验：
 * 上游变动导致锚点失配时立即失败，等待人工复查。
 * @param options.stage - staging 根目录。
 * @param options.productName - 产品名（来自 product.json）。
 */
export function brandInstalledRuntimePrompts({ stage, productName }) {
  const desktopModules = resolve(stage, 'dsh-plugin-desktop', 'node_modules')

  const replaceOnce = (path, replacements) => {
    let content = readFileSync(path, 'utf8')
    let changed = false
    for (const [from, to, expected] of replacements) {
      const count = content.split(from).length - 1
      if (count === expected) {
        content = content.replaceAll(from, to)
        changed = true
        continue
      }
      // node_modules 跨装配保留（见 steps/staging-prepare.mjs），本函数因此会撞上
      // 自己上一轮改过的文件：锚点已经不在，但替换结果按预期次数在位。那是已生效，
      // 不是上游漂移——上游真变了的话两者都对不上，仍旧抛错。
      if (count === 0 && content.split(to).length - 1 === expected) continue
      throw new Error(
        `configure-product: 品牌锚点 "${from.slice(0, 48)}..." 在 ${path} 出现 ${count} 次,预期 ${expected} 次`,
      )
    }
    if (changed) writeFileSync(path, content)
  }

  // 1) app-boot:源码检出说明行("The DeepSeek Harness implementation checkout is at...")。
  replaceOnce(resolve(desktopModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'), [
    ['The DeepSeek Harness implementation checkout is at', `The ${productName} implementation checkout is at`, 1],
  ])

  // 2) web-app:GUI 说明行与 webUrl 变量描述("DeepSeek Harness Web GUI",两处)。
  replaceOnce(resolve(desktopModules, '@deepseek-ai', 'dsh-web-app', 'lib', 'index.js'), [
    ['DeepSeek Harness Web GUI', `${productName} Web GUI`, 2],
  ])

  // 3) agent 预设 persona:"coding agent" 改为通用助手身份,产品名入句。
  //    新版由 dsh-agent-presets 独立发布 standard/PTC/Cordis 三套预设。
  const presetsRoot = resolve(desktopModules, '@deepseek-ai', 'dsh-agent-presets', 'presets')
  const generalPersona = `You are a versatile AI assistant inside ${productName}, powered by the {{model}} model. You handle coding, research, writing, and everyday tasks alike. Your working directory is {{cwd}}.`
  for (const preset of ['standard', 'ptc']) {
    replaceOnce(resolve(presetsRoot, preset, 'agent.cordis.yml'), [
      [
        'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
        generalPersona,
        1,
      ],
    ])
  }
  replaceOnce(resolve(presetsRoot, 'cordis', 'agent.cordis.yml'), [
    [
      'You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.',
      generalPersona,
      1,
    ],
  ])
}
