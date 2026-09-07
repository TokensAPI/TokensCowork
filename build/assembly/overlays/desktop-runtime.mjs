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

/** 取出一个顶层 Vitest `it()` 用例，供 Stable/Beta 精确同步。 */
function namedTestBlock(source, title) {
  const marker = `  it(${JSON.stringify(title).replaceAll('"', "'")}, () => {`
  if (source.split(marker).length !== 2) {
    throw new Error(`prepare-desktop: 上游 package smoke 用例 ${JSON.stringify(title)} 不唯一`)
  }
  const start = source.indexOf(marker)
  const candidates = [
    source.indexOf('\n\n  it(', start + marker.length),
    source.indexOf('\n})', start + marker.length),
  ].filter(index => index > start)
  if (candidates.length === 0) {
    throw new Error(`prepare-desktop: 无法确定 package smoke 用例 ${JSON.stringify(title)} 的边界`)
  }
  return source.slice(start, Math.min(...candidates))
}

/**
 * Stable Desktop 在产品装配时使用 Beta 的最新 DSH 运行时，因此两个补丁
 * smoke 也必须采用 Beta 已维护的新运行时断言。只同步对应测试块，不改上游
 * Stable/Beta 子模块源码，也不复制两者其余发行通道差异。
 */
export function alignStablePackageRuntimeTests(stableSource, betaSource) {
  let stable = stableSource.replaceAll('\r\n', '\n')
  const beta = betaSource.replaceAll('\r\n', '\n')
  const vmImportAnchor = "import { fileURLToPath, pathToFileURL } from 'node:url'"
  const resolutionAnchor = `const dshResolution = (name: string): unknown =>
  workspaceManifest.resolutions?.[\`${'${name}'}@npm:${'${runtimeVersion}'}\`]`
  if (!stable.includes(vmImportAnchor)
    || stable.includes("import { runInNewContext } from 'node:vm'")
    || stable.split(resolutionAnchor).length !== 2
    || !stable.includes("const betaRuntimeVersion = '0.1.3-alpha.1'")) {
    throw new Error('prepare-desktop: 未找到 Stable package runtime smoke 锚点')
  }
  stable = stable
    .replace(
      vmImportAnchor,
      `${vmImportAnchor}\nimport { runInNewContext } from 'node:vm'`,
    )
    .replace(
      resolutionAnchor,
      `${resolutionAnchor}\nconst latestDshResolution = (name: string): unknown =>\n  workspaceManifest.resolutions?.[\`${'${name}'}@npm:${'${betaRuntimeVersion}'}\`]`,
    )

  for (const title of [
    'hides official plugin-manager and general subprocess consoles on Windows',
    'starts restricted Windows shells with a hidden console show state',
  ]) {
    const stableBlock = namedTestBlock(stable, title)
    const betaBlock = namedTestBlock(beta, title)
      .replaceAll('dshResolution(', 'latestDshResolution(')
    stable = stable.replace(stableBlock, betaBlock)
  }
  const readdirImportAnchor = '  readFileSync,\n  readdirSync,\n'
  if (stable.split(readdirImportAnchor).length !== 2
    || (stable.match(/\breaddirSync\b/g) ?? []).length !== 1) {
    throw new Error('prepare-desktop: Stable package smoke readdirSync 清理锚点失配')
  }
  stable = stable.replace(readdirImportAnchor, '  readFileSync,\n')
  const nativeBuildFilesAnchor = "      '!node_modules/node-pty/build/**',\n    ])"
  if (stable.split(nativeBuildFilesAnchor).length !== 2) {
    throw new Error('prepare-desktop: Stable package 原生构建排除清单锚点失配')
  }
  stable = stable.replace(
    nativeBuildFilesAnchor,
    "      '!node_modules/node-pty/build/**',\n      '!node_modules/fs-ext/build/**',\n    ])",
  )
  return stable
}
