/* ============================================================
 * 产品覆盖：Windows 安装器
 * ============================================================
 * 把覆盖升级保护（upgrade-guard.nsh）编译进安装器与卸载器，并
 * 固定经过验证的 NSIS Unicode 插件资源。
 * 每个导出函数自带前置校验：资产缺失时装配立即失败。
 * ============================================================ */
import { cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 将覆盖升级保护写进 staging，由 electron-builder 同时编译进安装器和卸载器。
 * @param options.windowsInstallerRoot - 仓库内 Windows 安装器资产目录。
 * @param options.windowsInstallerIncludePath - staging 中 nsh 的落点。
 * @param options.desktopPackage - staging 的 desktop package.json 对象（原地修改）。
 * @param options.assertGeneratedPath - staging 越界守护。
 */
export function applyWindowsInstallerGuard({
  windowsInstallerRoot,
  windowsInstallerIncludePath,
  desktopPackage,
  assertGeneratedPath,
}) {
  const source = resolve(windowsInstallerRoot, 'installer', 'upgrade-guard.nsh')
  if (!existsSync(source)) {
    throw new Error(`configure-product: Windows installer guard is missing: ${source}`)
  }
  assertGeneratedPath(windowsInstallerIncludePath)
  cpSync(source, windowsInstallerIncludePath)
  desktopPackage.build.nsis.include = 'build/tokenscowork-upgrade-guard.nsh'
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
