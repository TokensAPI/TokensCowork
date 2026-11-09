// Microsoft Store（MSIX）商店包：和 EXE（NSIS）同一份 win-unpacked，多打一个 appx 目标。
// 包标识必须和 Partner Center 给的完全一致；不签名，Microsoft Store 收包后用自己的证书签。
// 商店版的更新交给 Microsoft Store（更新插件在商店包里改走 StoreContext，见 T0067）。

/**
 * Partner Center 的三项包标识。任何一项和商店不一致，上传时会被拒；这里只做形状校验，值以 product.json 为准。
 * @param {unknown} store - product.json 的 product.windowsStore。
 * @returns {{ identityName: string, publisher: string, publisherDisplayName: string }}
 */
export function storeIdentity(store) {
  if (!store || typeof store !== 'object') throw new Error('configure-product: product.windowsStore is missing')
  const { identityName, publisher, publisherDisplayName } = /** @type {Record<string, unknown>} */ (store)
  if (typeof identityName !== 'string' || !/^[A-Za-z0-9.-]{3,50}$/u.test(identityName)) {
    throw new Error('configure-product: product.windowsStore.identityName must be the Package/Identity/Name from Partner Center')
  }
  if (typeof publisher !== 'string' || !/^CN=[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u.test(publisher)) {
    throw new Error('configure-product: product.windowsStore.publisher must be the Package/Identity/Publisher from Partner Center (CN=<GUID>)')
  }
  if (typeof publisherDisplayName !== 'string' || publisherDisplayName.trim() === '') {
    throw new Error('configure-product: product.windowsStore.publisherDisplayName must be the PublisherDisplayName from Partner Center')
  }
  return { identityName, publisher, publisherDisplayName }
}

/**
 * 给 electron-builder 加 appx 配置（商店包）。NSIS 配置原样保留，商店包由单独一条
 * `electron-builder --win appx --prepackaged dist/win-unpacked` 命令从同一份程序目录打出来。
 * @param {any} desktopPackage - staging 的 desktop package.json 对象（原地修改）。
 * @param {{ name: string, windowsStore?: unknown }} product - product.json 的 product。
 */
export function configureWindowsStorePackage(desktopPackage, product) {
  const identity = storeIdentity(product.windowsStore)
  if (desktopPackage.build?.appx !== undefined) throw new Error('configure-product: upstream now configures appx; review before overriding')
  desktopPackage.build.appx = {
    identityName: identity.identityName,
    publisher: identity.publisher,
    publisherDisplayName: identity.publisherDisplayName,
    applicationId: product.name,
    displayName: product.name,
    // 图标透明底：开始菜单、任务栏跟随系统主题，不画色块
    backgroundColor: 'transparent',
    showNameOnTiles: false,
    languages: ['zh-CN', 'en-US'],
    // 开机自启由应用自己的设置决定，不在清单里加
    addAutoLaunchExtension: false,
    // 商店包的更新由 Microsoft Store 负责，不写 electron-updater 的更新信息
    electronUpdaterAware: false,
    artifactName: `${product.name}-\${version}-\${arch}-Store.\${ext}`,
  }
  return desktopPackage
}

/** 上游启动时给 Windows 设应用 ID 的那一句（任务栏分组、通知用）。 */
export const UPSTREAM_APP_USER_MODEL_ID = "    if (process.platform === 'win32') app.setAppUserModelId(DESKTOP_APP_ID)"

/**
 * 商店包里 Windows 已经按包标识分配了应用 ID（PackageFamilyName!App），任务栏、开始菜单、通知都认它；
 * 程序再设一个 com.tokensapi.tokenscowork 会和包标识对不上（通知不显示、任务栏固定的图标分成两个）。
 * Electron 在 MSIX 里运行时 process.windowsStore 为 true：商店包跳过，EXE 版不变。
 * @param {string} main - staging 副本 src/main.ts 的完整内容。
 * @returns {string}
 */
export function skipAppUserModelIdInStorePackage(main) {
  if (main.split(UPSTREAM_APP_USER_MODEL_ID).length !== 2) throw new Error('configure-product: setAppUserModelId anchor changed')
  return main.replace(UPSTREAM_APP_USER_MODEL_ID,
    "    // TokensCowork: Microsoft Store (MSIX) packages already have the package identity's app ID; setting ours breaks taskbar and toasts.\n"
    + "    if (process.platform === 'win32' && !process.windowsStore) app.setAppUserModelId(DESKTOP_APP_ID)")
}
