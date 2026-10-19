/* ============================================================
 * 产品覆盖：Profile 包不跨 DSH 运行时版本系列
 * ============================================================
 * Desktop 在 Profile 与安装包之间按版本高低选包。2.0.17 起只认当前
 * Profile 自己的 node_modules，但 TokensCowork 与官方 DSH 共用
 * ~/.dsh/profiles/desktop：官方程序装进去的下一版本系列运行时包版本
 * 更高，会替换本产品内置的运行时并在启动时加载失败（v0.5.25 曾因同类
 * 问题进入恢复模式）。DSH 运行时包的 Profile 副本与安装包不在同一
 * 版本系列时保留安装包；市场插件等其他包仍按新版本覆盖。
 * ============================================================ */
import { replaceOnce } from '../../pipeline/anchors.mjs'

/**
 * @param source - staging 副本中 src/package-overlay.ts 的完整内容。
 * @returns DSH 运行时包不跨版本系列覆盖的源码。
 */
export function keepDshRuntimeSeries(source) {
  source = source.replaceAll('\r\n', '\n')
  source = replaceOnce(source,
    "import { compare, valid } from 'semver'",
    "import { compare, major, minor, valid } from 'semver'",
    'package-overlay semver 导入')
  return replaceOnce(source,
    `      : profile.version !== undefined && install.version !== undefined
        && compare(profile.version, install.version) > 0 ? profile : install`,
    `      : profile.version !== undefined && install.version !== undefined
        && compare(profile.version, install.version) > 0
        && sameDshRuntimeSeries(packageName, profile.version, install.version) ? profile : install`,
    'package-overlay 版本选择')
    + `
/**
 * TokensCowork: a DSH runtime package from another release series (0.2 vs 0.3)
 * is incompatible with this Desktop; keep the installed copy instead.
 */
function sameDshRuntimeSeries(packageName: string, profileVersion: string, installVersion: string): boolean {
  if (!/^@deepseek-ai\\/dsh(?:$|-)/u.test(packageName)) return true
  return major(profileVersion) === major(installVersion)
    && (major(installVersion) !== 0 || minor(profileVersion) === minor(installVersion))
}
`
}
