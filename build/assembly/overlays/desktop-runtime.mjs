/* ============================================================
 * 产品覆盖：桌面运行时
 * ============================================================
 * 修复旧版本写入用户 profile 的托管插件重复项，并保护 GUI 启动
 * 时已关闭 stderr 管道下的诊断输出。
 * 每个导出函数自带锚点守护：上游代码变动导致锚点失配时装配立即
 * 失败，等待人工复查，绝不静默漏掉覆盖。
 * ============================================================ */

/**
 * 从持久 profile 的 bundle 列表中移除由产品补丁固定装配的插件。
 * 旧版本可能把这些插件写入用户 profile，升级后会与产品 Loader 条目重复。
 * @param source - staging 副本中 profile.ts 的完整内容。
 * @param packages - 当前产品默认启用、由产品补丁托管的插件包名。
 * @returns 启动时会自动修复旧 profile 的源码。
 * @throws 上游 profile 规范化锚点变化时抛出，中断打包待人工复查。
 */
export function removeManagedBundlesFromProfile(source, packages) {
  const setAnchor = 'const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)'
  const filterAnchor = '&& name !== DESKTOP_PACKAGE_NAME'
  if (!source.includes(setAnchor)
    || source.split(filterAnchor).length !== 2) {
    throw new Error('prepare-desktop: 未找到上游 profile bundle 规范化锚点，请复查产品插件迁移策略')
  }
  const managedPackages = JSON.stringify(packages, undefined, 2)
    .split('\n')
    .map((line, index) => index === 0 ? line : `  ${line}`)
    .join('\n')
  return source
    .replace(
      setAnchor,
      `${setAnchor}\nconst PRODUCT_MANAGED_BUNDLE_SET = new Set<string>(${managedPackages})`,
    )
    .replace(
      filterAnchor,
      `${filterAnchor}\n    && !PRODUCT_MANAGED_BUNDLE_SET.has(name)`,
    )
}

/**
 * 避免 Windows GUI 启动时已断开的 stderr 管道再次抛出 EPIPE，掩盖原始异常。
 * @param mainSource - staging 副本中 main.ts 的完整内容。
 * @param loggerSource - staging 副本中 desktop-logger.ts 的完整内容。
 * @returns 启动器与日志器均通过同一容错 writer 输出的源码。
 * @throws 上游 stderr 锚点变化时抛出，中断打包待人工复查。
 */
export function protectDesktopStderr(mainSource, loggerSource) {
  const mainImportAnchor = '  ElectronStderrLogger,\n'
  const loggerHelperAnchor = "import { maskSecrets } from './mask-secrets.ts'"
  const mainWrites = mainSource.match(/process\.stderr\.write\(/g) ?? []
  const loggerWrites = loggerSource.match(/process\.stderr\.write\(/g) ?? []
  if (!mainSource.includes(mainImportAnchor)
    || !loggerSource.includes(loggerHelperAnchor)
    || mainWrites.length === 0
    || loggerWrites.length !== 1) {
    throw new Error('prepare-desktop: 未找到上游桌面 stderr 锚点，请复查 Windows GUI 异常处理')
  }
  const main = mainSource
    .replaceAll('process.stderr.write(', 'writeDesktopStderr(')
    .replace(
      mainImportAnchor,
      `${mainImportAnchor}  writeDesktopStderr,\n`,
    )
  const logger = loggerSource
    .replaceAll('process.stderr.write(', 'writeDesktopStderr(')
    .replace(
      loggerHelperAnchor,
      `${loggerHelperAnchor}\n\n// A Windows GUI launch may expose an already-closed stderr pipe.\nprocess.stderr.on('error', () => {})\n\n/** Write diagnostics when a live stderr pipe exists. */\nexport function writeDesktopStderr(\n  message: string,\n  callback?: (error?: Error | null) => void,\n): boolean {\n  if (process.stderr.destroyed || !process.stderr.writable) {\n    callback?.()\n    return false\n  }\n  try {\n    return process.stderr.write(message, callback)\n  } catch {\n    callback?.()\n    return false\n  }\n}`,
    )
  if ((main.match(/process\.stderr\.write\(/g) ?? []).length !== 0
    || (logger.match(/process\.stderr\.write\(/g) ?? []).length !== 1) {
    throw new Error('prepare-desktop: 桌面 stderr 改写不完整，请复查 Windows GUI 异常处理')
  }
  return { main, logger }
}
