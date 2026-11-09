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
    // 需要底板的地方（开始菜单磁贴、浅色任务栏缺无底板图标时）用白底；transparent 会被系统填成强调色（蓝底）
    backgroundColor: '#FFFFFF',
    showNameOnTiles: false,
    languages: ['zh-CN', 'en-US'],
    // 关闭文件 / 注册表写入重定向（见 storeManifestTemplate）：和 EXE 版读写同一个 %APPDATA%\TokensCowork，
    // 外部程序（资源管理器、编辑器、插件起的进程）看得到应用写的文件。unvirtualizedResources 是受限权限，提交商店时要写理由。
    capabilities: ['runFullTrust', 'unvirtualizedResources'],
    customManifestPath: 'appxmanifest.xml',
    // desktop6 的关闭重定向从 Windows 10 1809（17763）起支持
    minVersion: '10.0.17763.0',
    maxVersionTested: '10.0.26100.0',
    // 开机自启由应用自己的设置决定，不在清单里加
    addAutoLaunchExtension: false,
    // 商店包的更新由 Microsoft Store 负责，不写 electron-updater 的更新信息
    electronUpdaterAware: false,
    artifactName: `${product.name}-\${version}-\${arch}-Store.\${ext}`,
  }
  return desktopPackage
}

const RESCAP_NAMESPACE = 'xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"'
const DESKTOP6_NAMESPACE = 'xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"'

/**
 * 商店包清单模板：在 electron-builder 自带的 appx 模板上加「关闭文件与注册表写入重定向」。
 * MSIX 默认把应用在 %APPDATA% 下新建的文件夹转到商店私有目录（2026-11-09 在本机实测：已存在的 TokensCowork 目录写真实位置，
 * 新建目录写 LocalCache）。没装过 EXE 版的电脑上数据目录就会建在私有区域：外部程序看不到，之后装 EXE 版也不互通。
 * 只在模板上加两行、不另抄一份，electron-builder 升级时跟着它的模板走；锚点变了就失败。
 * @param {string} template - staging 里 app-builder-lib/templates/appx/appxmanifest.xml 的内容。
 * @returns {string}
 */
export function storeManifestTemplate(template) {
  if (template.split(RESCAP_NAMESPACE).length !== 2) throw new Error('configure-product: appx template rescap namespace anchor changed')
  if (template.split('</Properties>').length !== 2) throw new Error('configure-product: appx template Properties anchor changed')
  if (!template.includes('${capabilities}')) throw new Error('configure-product: appx template no longer renders ${capabilities}')
  if (template.includes('desktop6:')) throw new Error('configure-product: appx template already declares desktop6; review before overriding')
  return template
    .replace(RESCAP_NAMESPACE, `${DESKTOP6_NAMESPACE}\n   ${RESCAP_NAMESPACE}`)
    .replace('</Properties>', '    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>\n'
      + '    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>\n  </Properties>')
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
