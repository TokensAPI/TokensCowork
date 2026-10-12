/* ====================================================================
 * staging 中被覆盖修改的上游文件
 * 登记表通过这里引用目标路径：上游移动或删除某个文件时，从这一处就能
 * 查到受影响的覆盖（`yarn product:overlays --file <路径>` 反查调用方）。
 * 路径相对 staging 根目录，与 desktop/ 子模块内的位置一一对应。
 * ==================================================================== */

const desktop = 'dsh-plugin-desktop'
const installed = `${desktop}/node_modules`

/** 上游 Desktop 源码与构建脚本。 */
export const desktopFiles = {
  workspacePackage: { path: 'package.json', json: true },
  yarnConfig: '.yarnrc.yml',
  desktopPackage: { path: `${desktop}/package.json`, json: true },
  // prepare 阶段按 LF、去尾部空白读取；产品插件补丁随后以空行拼接在后面。
  desktopPatchSource: { path: `${desktop}/cordis.patch.yml`, read: text => text.replaceAll('\r\n', '\n').trimEnd() },
  desktopPatch: `${desktop}/cordis.patch.yml`,
  main: `${desktop}/src/main.ts`,
  hostProcess: `${desktop}/src/host-process.ts`,
  hostProcessEntry: `${desktop}/src/host-process-entry.ts`,
  logger: `${desktop}/src/desktop-logger.ts`,
  hostRuntimeBridge: `${desktop}/src/host-runtime-bridge.ts`,
  runtimeTypes: `${desktop}/src/runtime.ts`,
  windowsAclRunner: `${desktop}/src/windows-acl-runner.ts`,
  windowsPwshSandbox: `${desktop}/src/windows-pwsh-sandbox.ts`,
  packageOverlay: `${desktop}/src/package-overlay.ts`,
  productIdentity: `${desktop}/src/product-identity.ts`,
  index: `${desktop}/src/index.ts`,
  certificate: `${desktop}/src/lan-https-certificate.ts`,
  titlebar: `${desktop}/src/client/DesktopFrameTitlebarView.tsx`,
  settingsLocales: `${desktop}/src/client/desktop-settings-locales.ts`,
  assistedMessages: `${desktop}/build/assistedMessages.yml`,
  profileBootVerifier: `${desktop}/scripts/verify-profile-boot.mjs`,
  cliRuntimeVerifier: `${desktop}/scripts/verify-cli-runtime.mjs`,
  fsExtPrepare: `${desktop}/scripts/prepare-fs-ext.ts`,
  releaseMac: `${desktop}/scripts/release-mac.ts`,
  verifyMacRelease: `${desktop}/scripts/verify-mac-release.ts`,
  verifyMacEntitlements: `${desktop}/scripts/verify-mac-entitlements.ts`,
  moduleResolutionTests: `${desktop}/tests/module-resolution.spec.ts`,
}

/** 已安装的 npm 运行时；installed 阶段同时检查 Desktop 与根工作区两份依赖。 */
export const installedPackage = (name, file = 'lib/index.js') => ({
  desktop: { path: `${installed}/${name}/${file}`, optional: true },
  root: { path: `node_modules/${name}/${file}`, optional: true },
})

/** 只在 Desktop 依赖树中使用的已安装文件。 */
export const desktopInstalled = (name, file = 'lib/index.js') => `${installed}/${name}/${file}`

/** 产品插件在 staging 中的位置。 */
export const productPlugin = (id, file = '') => `${desktop}/product-plugins/${id}${file ? `/${file}` : ''}`

/** 社区市场源码。 */
export const market = file => `dsh-community-market/${file}`

/** product.json 中默认启用的插件。 */
export const pluginEnabled = (product, id) => product.plugins.some(plugin => plugin.id === id && plugin.enabledByDefault === true)

/**
 * installed 阶段的标准形态：两份依赖树各自存在时都要处理，至少一份存在。
 * @param name - npm 包名。
 * @param transform - 已安装文件内容 → 新内容；必须可重复执行。
 * @param missing - 两份都不存在时的报错。
 */
export function installedOverlay(name, transform, missing) {
  return {
    files: installedPackage(name),
    apply: ({ desktop, root }) => {
      if (desktop === undefined && root === undefined) throw new Error(missing)
      return {
        desktop: desktop === undefined ? undefined : transform(desktop),
        root: root === undefined ? undefined : transform(root),
      }
    },
  }
}
