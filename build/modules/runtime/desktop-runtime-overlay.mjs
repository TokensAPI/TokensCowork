/* ============================================================
 * 产品覆盖：桌面运行时
 * ============================================================
 * 统一产品首次启动行为，保护 GUI stderr，并适配上游平台测试。
 * 每个导出函数自带锚点守护：上游代码变动导致锚点失配时装配立即
 * 失败，等待人工复查，绝不静默漏掉覆盖。
 * ============================================================ */

/**
 * TokensCowork 采用已装配的 Profile 默认值，不向用户展示上游首次设置向导。
 * 保留上游 skip 状态写入路径，使同一 Profile 后续启动与版本迁移仍有完整状态。
 * @param mainSource - staging 副本中 main.ts 的完整内容。
 * @returns 将向导运行替换为产品级静默跳过后的源码。
 * @throws 上游启动链锚点变化时抛出，中断打包待人工复查。
 */
export function skipDesktopSetupWizard(mainSource) {
  // 2.0.17 将向导接入页面级 onboarding；沿用产品默认配置并写入跳过标记。
  const pendingAnchor = '    let setupPending = safeModePaths === undefined'
  if (mainSource.split(pendingAnchor).length !== 2) {
    throw new Error('prepare-desktop: 未找到上游首次设置向导锚点，请复查产品默认设置策略')
  }
  return mainSource.replace(pendingAnchor, `    if (safeModePaths === undefined) {
      if (desktopSetupWizardRequired(setupWizardState, setupWizardVersions)) {
        await completeOrSkipDesktopSetupWizard(marketUserDataDir, prepared.profile.dir, 'skipped', setupWizardVersions)
      }
      dismissDesktopSetupAccount(marketUserDataDir, prepared.profile.dir)
    }
${pendingAnchor}
    // 产品用已装配 Profile 的默认值，向导永不进入待办；保留上游这一行，
    // 上游 package.spec.ts 按字面断言它的存在。
    setupPending = false`)
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
    || ![1, 2].includes(loggerWrites.length)) {
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

/**
 * 对齐上游 CLI smoke 与 Windows 后台 Node 启动实现。
 * Windows 的批处理 shim 必须保留 Electron Node 模式，且通过 `bin\\..`
 * 暴露的 NODE 路径与规范化路径等价；旧 smoke 仍按清理变量和字符串直比验收。
 * @param source - staging 副本中 verify-cli-runtime.mjs 的完整内容。
 * @returns 按平台验收 Node 模式并规范化生命周期 Node 路径的 smoke 脚本。
 * @throws 上游 smoke 锚点变化时抛出，中断打包待人工复查。
 */
export function alignCliRuntimeSmokeWithPlatform(source) {
  const pathImportAnchor = "import { join } from 'node:path'"
  const actualAnchor = "  const actual = JSON.parse(readFileSync(resultPath, 'utf8'))\n  const expected = {"
  const runAsNodeAnchor = '    runAsNode: [],'
  const nodeAnchor = '    node: installation.nodeShimPath,\n    npmNodeExecPath: installation.nodeShimPath,'
  if (!source.includes(pathImportAnchor)
    || source.split(actualAnchor).length !== 2
    || source.split(runAsNodeAnchor).length !== 2
    || source.split(nodeAnchor).length !== 2) {
    throw new Error('prepare-desktop: 未找到上游 CLI runtime smoke 锚点，请复查平台环境验收')
  }
  return source
    .replace(pathImportAnchor, "import { join, resolve } from 'node:path'")
    .replace(
      actualAnchor,
      "  const actual = JSON.parse(readFileSync(resultPath, 'utf8'))\n  actual.node = resolve(actual.node)\n  actual.npmNodeExecPath = resolve(actual.npmNodeExecPath)\n  const expected = {",
    )
    .replace(
      runAsNodeAnchor,
      "    runAsNode: process.platform === 'win32' ? ['ELECTRON_RUN_AS_NODE'] : [],",
    )
    .replace(
      nodeAnchor,
      '    node: resolve(installation.nodeShimPath),\n    npmNodeExecPath: resolve(installation.nodeShimPath),',
    )
}

/** Upstream resolver unit fixtures use POSIX file URLs; Windows needs a drive. */
export function alignResolverTestFileUrls(source, platform = process.platform) {
  return platform === 'win32'
    ? source.replaceAll(/file:\/\/\/(?![a-zA-Z]:\/)/gu, 'file:///C:/')
    : source
}
