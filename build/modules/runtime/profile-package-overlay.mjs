/* ============================================================
 * 产品覆盖：Profile 包选择
 * ============================================================
 * Desktop 2.0.9 在 Profile 与安装包之间按版本高低选包，但 Profile
 * 一侧用 Node 的祖先目录查找：~/.dsh/profiles/node_modules、~/.dsh、
 * ~ 下其他程序留下的新版包也会被当成 Profile 覆盖。共用 ~/.dsh 的
 * DSH 0.2 程序装了 dsh-web-app 0.2 后，0.1 加载器读不懂其数组形式的
 * bundle 声明，启动进入恢复模式。
 * 1. 只接受当前 Profile 自己 node_modules 下的包（与上游 2.0.17 相同）。
 * 2. DSH 运行时包的 Profile 副本与安装包不在同一版本系列时不采用。
 * ============================================================ */

function replaceOnce(source, anchor, replacement, label) {
  if (source.split(anchor).length !== 2) throw new Error(`prepare-desktop: 未找到上游${label}锚点，请复查 Profile 包选择覆盖`)
  return source.replace(anchor, () => replacement)
}

/**
 * @param source - staging 副本中 src/package-overlay.ts 的完整内容。
 * @returns Profile 候选限制在当前 Profile、DSH 运行时不跨版本系列的源码。
 * @throws 上游锚点变化时抛出，中断装配待人工复查。
 */
export function restrictProfilePackageOverlay(source) {
  source = source.replaceAll('\r\n', '\n')
  if (source.includes('Only the active Profile owns overrides')) {
    throw new Error('prepare-desktop: 上游已限制 Profile 包查找范围，请复查并删除 runtime.profile-packages 覆盖')
  }
  source = replaceOnce(source,
    "import { dirname } from 'node:path'\nimport { compare, valid } from 'semver'",
    "import { dirname, isAbsolute, join, relative, sep } from 'node:path'\nimport { fileURLToPath } from 'node:url'\nimport { compare, major, minor, valid } from 'semver'",
    'package-overlay 导入')
  source = replaceOnce(source,
    '  if (manifestPath === undefined) return undefined\n',
    `  if (manifestPath === undefined) return undefined
  if (source === 'profile') {
    // TokensCowork: only the active Profile owns overrides. Node's ancestor walk
    // also finds packages other DSH installs left in profiles/node_modules or ~.
    const modules = join(dirname(fileURLToPath(packageUrl)), 'node_modules')
    const offset = relative(modules, manifestPath)
    if (offset === '..' || offset.startsWith(\`..\${sep}\`) || isAbsolute(offset)) return undefined
  }
`,
    'package-overlay 候选读取')
  return replaceOnce(source,
    `      : profile.version !== undefined && install.version !== undefined
        && compare(profile.version, install.version) > 0 ? profile : install`,
    `      : profile.version !== undefined && install.version !== undefined
        && compare(profile.version, install.version) > 0
        && sameDshRuntimeSeries(packageName, profile.version, install.version) ? profile : install`,
    'package-overlay 版本选择')
    + `
/**
 * TokensCowork: a DSH runtime package from another release series (0.1 vs 0.2)
 * is incompatible with this Desktop; keep the installed copy instead.
 */
function sameDshRuntimeSeries(packageName: string, profileVersion: string, installVersion: string): boolean {
  if (!/^@deepseek-ai\\/dsh(?:$|-)/u.test(packageName)) return true
  return major(profileVersion) === major(installVersion)
    && (major(installVersion) !== 0 || minor(profileVersion) === minor(installVersion))
}
`
}
