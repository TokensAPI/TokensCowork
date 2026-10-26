/* ====================================================================
 * branding 覆盖登记表
 * 产品身份、可见文案、提示词、Logo 与图标、旧用户数据迁移、隐藏上游云入口。
 * ==================================================================== */
import { resolve } from 'node:path'
import { desktopFiles as d, desktopInstalled, pluginEnabled, productPlugin } from '../../pipeline/stage-targets.mjs'
import { applyProductLogo, brandDesktopIconConfiguration, generateProductIcons } from './branding-assets.mjs'
import { brandTurnStatusCopy } from './turn-status-copy-overlay.mjs'
import {
  brandDesktopPatch,
  brandDesktopSources,
  brandMacReleaseVerification,
  brandNativeCopyText,
  alignSidebarAccountRow,
  brandProfileBootTerminalCheck,
  nativeCopyPaths,
} from './branding-overlay.mjs'
import { brandInstalledRuntime, hideUpstreamAccountSection, hideUpstreamFeedbackEntry } from './branding-runtime-overlay.mjs'

// 这几份源码按 LF 读取后再匹配，避免 Windows 检出的 CRLF 让锚点失配。
const lf = path => ({ path, read: text => text.replaceAll('\r\n', '\n') })
const nativeCopy = Object.fromEntries(nativeCopyPaths.map(parts => [parts.join('/'), `dsh-plugin-desktop/${parts.join('/')}`]))

export default [
  {
    id: 'branding.desktop-patch',
    phase: 'prepare',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: { patch: d.desktopPatchSource },
    apply: ({ patch }, { product }) => ({ patch: brandDesktopPatch(patch, product.product.name) }),
    why: '停用上游官方 UI 品牌插件，系统提示词身份行改为产品名。',
    retireWhen: '产品使用独立品牌期间保留。',
  },
  {
    id: 'branding.sidebar-account-row',
    phase: 'assemble',
    upstream: ['plugin:tokens-login'],
    kind: 'workaround',
    when: ({ product }) => pluginEnabled(product, 'tokens-login'),
    files: { client: productPlugin('tokens-login', 'dsh/client.js') },
    apply: ({ client }) => ({ client: alignSidebarAccountRow(client) }),
    why: '登录插件照搬上游账号菜单的 24px 头像与 6px 左边距，已登录时头像和名字比上方“插件市场”行偏右；只对已登录且侧栏展开的账号行改为 20px 头像、4px 左边距、6px 间距，与市场行对齐。',
    retireWhen: '登录插件或上游账号菜单自行与侧栏其他行对齐后移除。',
  },
  {
    id: 'branding.hide-feedback',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'customization',
    files: { client: desktopInstalled('@deepseek-ai/dsh-client-ui-settings-account', 'lib/client.js') },
    apply: ({ client }) => ({ client: hideUpstreamFeedbackEntry(client) }),
    why: '侧栏“更多”菜单中的“意见反馈”指向上游官方渠道，产品不提供；只移除该菜单项，设置与账号项保留。',
    retireWhen: '上游提供隐藏该入口的配置，或产品接入自己的反馈渠道后移除。',
  },
  {
    id: 'branding.hide-deepseek-account',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'customization',
    files: { client: desktopInstalled('@deepseek-ai/dsh-client-ui-settings-account', 'lib/client.js') },
    apply: ({ client }) => ({ client: hideUpstreamAccountSection(client) }),
    why: '设置中不显示上游 DeepSeek 官方账号页；产品账号由 tokens-login 的“TokensAPI 账户”页管理。只停止注册该页，账号插件其余逻辑不变。',
    retireWhen: '产品改为支持 DeepSeek 官方账号，或上游提供关闭该页的配置时移除。',
  },
  {
    id: 'branding.turn-status-copy',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'customization',
    files: { client: desktopInstalled('@deepseek-ai/dsh-client-ui-chat', 'lib/client.js') },
    apply: ({ client }) => ({ client: brandTurnStatusCopy(client) }),
    why: '一轮执行中的状态行是上游品牌说法「深度求索中」/「Deep diving」；改语言表的四条值，不依赖渲染后匹配（UI 插件原来的按文字替换在 DSH 0.2.1 改文案后已失效）。',
    retireWhen: '上游改为可配置的产品措辞，或该状态行改由插槽提供时移除。',
  },
  {
    id: 'branding.desktop-source',
    phase: 'configure',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: {
      identity: lf(d.productIdentity),
      main: lf(d.main),
      index: lf(d.index),
      certificate: lf(d.certificate),
      titlebar: lf(d.titlebar),
      settingsLocales: lf(d.settingsLocales),
      assistedMessages: lf(d.assistedMessages),
    },
    apply: (input, { product }) => brandDesktopSources(input, product.product),
    why: '产品身份唯一来源、窗口标题、本地证书名、标题栏与设置文案、安装器提示，以及 TokensHarness 旧用户数据迁移。',
    retireWhen: '产品使用独立品牌期间保留；旧数据迁移只能在停止支持旧用户后另行决定。',
  },
  {
    id: 'branding.native-copy',
    phase: 'configure',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: nativeCopy,
    apply: (input, { product }) => Object.fromEntries(Object.entries(input)
      .map(([path, source]) => [path, brandNativeCopyText(source, path, product.product.name)])),
    why: '原生对话框、托盘、恢复窗口、通知、终端与原生页面标题只含显示文案，整体替换上游品牌。',
    retireWhen: '产品使用独立品牌期间保留；上游不再带品牌的文件从列表中移除。',
  },
  {
    id: 'branding.profile-terminal-check',
    phase: 'configure',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: { verifier: d.profileBootVerifier },
    apply: ({ verifier }, { product }) => ({ verifier: brandProfileBootTerminalCheck(verifier, product.product.name) }),
    why: 'branding.native-copy 把托盘“Open DSH Terminal”改为产品名；Profile 启动验收同步按产品文案查找终端入口，仍要求该入口存在。',
    retireWhen: '随 branding.native-copy 的托盘文案替换一起移除。',
  },
  {
    id: 'branding.mac-release-identity',
    phase: 'configure',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: { script: d.verifyMacRelease },
    apply: ({ script }, { product }) => ({ script: brandMacReleaseVerification(script, product.product.name) }),
    why: 'macOS 发布校验按产品名查找应用；架构与签名逻辑仍由 platform 负责。',
    retireWhen: '随产品品牌保留。',
  },
  {
    id: 'branding.icon-configuration',
    phase: 'configure',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: { desktopPackage: d.desktopPackage },
    apply: ({ desktopPackage }, { product }) => {
      brandDesktopIconConfiguration(desktopPackage, product.product.name)
      return { desktopPackage }
    },
    why: 'macOS / DMG / Windows 图标使用生成的产品图标，麦克风权限提示使用产品名。',
    retireWhen: '随产品品牌保留。',
  },
  {
    id: 'branding.product-logo',
    phase: 'configure',
    upstream: ['desktop', 'dsh', 'product'],
    kind: 'customization',
    targets: [
      'dsh-plugin-desktop/build/{app-icon.png,logo-mark.png,tray-icon.svg}',
      'dsh-plugin-desktop/scripts/generate-product-icons.mjs',
      'node_modules/@deepseek-ai/dsh-web-frontend/dist/{favicon.svg,favicon-dark.svg,tokenscowork-logo.png,manifest.webmanifest}',
      'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js',
    ],
    run: ({ stage, product }) => applyProductLogo({
      productBrandRoot: resolve(import.meta.dirname, 'assets'),
      stage,
      productName: product.product.name,
      assertGeneratedPath: () => {},
    }),
    why: '前端 Logo、favicon、托盘 SVG 与 Web 清单使用产品资产，并清除旧的派生图标以便重新生成。',
    retireWhen: '随产品品牌保留。',
  },
  {
    id: 'branding.installed-runtime',
    phase: 'configure',
    upstream: ['dsh', 'desktop', 'product'],
    kind: 'customization',
    targets: [
      'node_modules/@agents-anywhere/dsh-bridge-next/lib/client.js',
      'node_modules/@deepseek-ai/{dsh-client-ui-directory-picker-browse,dsh-client-ui-layout,dsh-app-boot,dsh-web-app}',
      'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    ],
    run: ({ stage, product }) => brandInstalledRuntime({ stage, productName: product.product.name }),
    why: '已编译 npm 运行时的标题、提示词、声明式预设与错误文案改为产品名；隐藏上游手机连接（Agents Anywhere）侧栏入口。',
    retireWhen: '随产品品牌保留；上游提供可配置的导航开关时评估移除云入口隐藏。',
  },
  {
    id: 'branding.product-icons',
    phase: 'configure',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    targets: ['dsh-plugin-desktop/build/{app-icon.ico,app-icon.icns,app-icon-mac.png,tray-icon*.png}'],
    run: ({ stage }) => generateProductIcons(stage),
    why: '用固定上游的应用图标渲染器生成 ICO、ICNS 与各 DPI 托盘位图。',
    retireWhen: '随产品品牌保留。',
  },
]

/** 本模块不修改 staging 的脚本。 */
export const checks = [
  { file: 'staging-branding-verify.mjs', runBy: 'build/build.mjs（Desktop 编译后自动执行）' },
]
