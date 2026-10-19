/* ============================================================
 * 产品覆盖：Windows 安装器
 * ============================================================
 * 把覆盖升级保护（upgrade-guard.nsh）编译进安装器与卸载器，并
 * 固定经过验证的 NSIS Unicode 插件资源。
 * 由 platform/overlays.mjs 登记，执行器负责读写文件。
 * ============================================================ */

/**
 * 把覆盖升级保护写进 staging，由 electron-builder 同时编译进安装器和卸载器。
 * @param desktopPackage - staging 的 desktop package.json 对象。
 * @param guard - 产品升级保护脚本（assets/windows/installer/upgrade-guard.nsh）。
 * @returns 设置 include 后的 package 与要写入 staging 的保护脚本。
 * @throws 保护脚本缺少关键宏，或上游配置为卸载时删除用户数据时抛出。
 */
export function addWindowsInstallerGuard(desktopPackage, guard) {
  for (const required of ['customUnInstallCheck', 'customRemoveFiles', 'SetErrorLevel 2']) {
    if (!guard.includes(required)) throw new Error(`Windows installer guard lacks ${required}`)
  }
  // 卸载与覆盖升级都不能删除用户数据；上游改变该默认值时中断待复查。
  if (desktopPackage.build.nsis.deleteAppDataOnUninstall === true) {
    throw new Error('upstream NSIS deletes user data on uninstall')
  }
  desktopPackage.build.nsis.include = 'build/tokenscowork-upgrade-guard.nsh'
  return { desktopPackage, guard }
}

/**
 * 固定 NSIS 编译资源：3.12 编译器带长路径支持，但其 1.2.1 捆绑包把 ANSI
 * 版 nsisunz.dll 放进了 Unicode 插件目录。保留新编译器，ZIP 解压改用
 * 此前验证过的 Unicode 插件资源。
 * @param desktopPackage - staging 的 desktop package.json 对象（原地修改）。
 */
export function pinNsisResources(desktopPackage) {
  desktopPackage.build.nsis.customNsisResources = {
    url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z',
    checksum: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103',
    version: '3.4.1',
  }
}
