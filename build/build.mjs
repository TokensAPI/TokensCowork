import { spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { productStage } from './pipeline/paths.mjs'
import { withoutPnpLoader } from './pipeline/node-environment.mjs'
import { adaptAppleReleaseEnvironment } from './modules/platform/mac-signing-resolve.mjs'

/* ====================================================================
 * TokensCowork 桌面产品构建入口
 *
 * 所有模式都先在 `.build/desktop` 组装只读上游与产品插件，再按目标执行
 * 校验或原生打包。构建过程不得修改 desktop/ 与 plugins/ 子模块工作树。
 * ==================================================================== */

const root = resolve(import.meta.dirname, '..')
const stage = productStage(root)
const mode = process.argv[2]
const planOnly = process.argv.includes('--plan')
if (process.argv.slice(3).some(arg => arg !== '--plan')) throw new Error('Unexpected build argument')
let stepNumber = 0
let phase = 'assemble'
if (!['check', 'win', 'win-check', 'mac', 'mac-unsigned'].includes(mode)) {
  throw new Error('build-desktop: expected check, win, mac, or mac-unsigned')
}

// 未签名或本地 macOS 构建不得继承正式发布凭据，避免构建工具自动选择
// Developer ID 签名、钥匙串身份或公证流程。
const MAC_RELEASE_VARIABLES = [
  'APPLE_CERT_BASE64', 'APPLE_CERT_PASSWORD', 'APPLE_APP_PASSWORD',
  'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE', 'APPLE_TEAM_ID', 'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_NAME', 'MACOS_SIGN_IDENTITY',
  'MAC_CERT_P12_BASE64',
]

/** 返回移除全部 macOS 正式发布凭据后的独立环境副本。 */
function withoutMacReleaseSecrets(environment) {
  const sanitized = { ...environment }
  for (const name of MAC_RELEASE_VARIABLES) delete sanitized[name]
  return sanitized
}

/**
 * 同步执行一个构建命令，并将输出直接转交当前终端。
 * Windows 上通过 cmd.exe 启动 corepack，确保 `.cmd` shim 可被可靠解析。
 */
function run(command, args, cwd, env = process.env) {
  const displayCommand = command === process.execPath ? 'node' : command
  const displayArgs = args.map(arg => arg.startsWith(root) ? relative(root, arg).replaceAll('\\', '/') : arg)
  console.log(`[${String(++stepNumber).padStart(2, '0')} ${phase}] ${displayCommand} ${displayArgs.join(' ')} (cwd: ${relative(root, cwd).replaceAll('\\', '/') || '.'})`)
  if (planOnly) return
  const windowsCorepack = process.platform === 'win32' && command === 'corepack'
  const executable = windowsCorepack
    ? process.env.ComSpec ?? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    : command
  const resolvedArgs = windowsCorepack
    ? ['/d', '/s', '/c', `corepack ${args.map(quoteCmdArgument).join(' ')}`]
    : args
  const result = spawnSync(executable, resolvedArgs, { cwd, env: withoutPnpLoader(env), stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/** 将产品品牌和发布配置写入 staging 工作区。 */
function configureProduct(environment = process.env, packagingTarget = 'default') {
  run(
    process.execPath,
    [resolve(root, 'build', 'pipeline', 'staging-product-configure.mjs'), packagingTarget],
    root,
    environment,
  )
}

/** 编译实际交付的市场与 Desktop，避免上游总构建重复编译 Beta 产品。 */
function buildProduct(environment = process.env) {
  for (const workspace of ['dsh-community-market', 'dsh-plugin-desktop']) {
    run('corepack', ['yarn', 'workspace', workspace, 'build'], stage, environment)
  }
}

/** 为指定 macOS 架构编译与 Electron ABI 一致的 fs-ext 原生绑定，并恢复 uv 执行位。 */
function prepareMacNativeRuntime(architectures, environment = process.env) {
  for (const architecture of architectures) {
    run(
      process.execPath,
      [resolve(stage, 'dsh-plugin-desktop', 'scripts', 'prepare-fs-ext.ts'), architecture],
      resolve(stage, 'dsh-plugin-desktop'),
      environment,
    )
  }
  // 安装 uv 时跳过了宿主 postinstall，node_modules 中的二进制没有执行位。上游只在
  // 通用包合并（mac-universal）时恢复，单架构打包必须自行恢复，否则 electron-builder
  // 的 afterPack 校验会以 EACCES 失败。
  run(process.execPath, [resolve(stage, 'scripts', 'prepare-agents-anywhere-runtime.mjs')], stage, environment)
}

/** 验证产品品牌已经进入源码配置与编译后的运行时闭包。 */
function verifyProductBranding(environment = process.env) {
  run(process.execPath, [resolve(root, 'build', 'modules', 'branding', 'staging-branding-verify.mjs')], root, environment)
}

/** 配置、编译并验收一个可供平台打包器消费的产品工作区。 */
function configureBuildAndVerifyProduct(environment = process.env, packagingTarget = 'default') {
  configureProduct(environment, packagingTarget)
  buildProduct(environment)
  verifyProductBranding(environment)
}

/** 将参数编码为可安全传给 Windows cmd.exe 的单个命令行参数。 */
function quoteCmdArgument(value) {
  if (/^[A-Za-z0-9:._@/=-]+$/u.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

/** 验证 macOS 构建运行器与请求的目标架构一致，并返回目标架构。 */
function assertNativeMacArchitecture() {
  if (!planOnly && process.platform !== 'darwin') throw new Error('macOS packaging requires macOS')
  const requestedArch = process.env.DSH_MAC_ARCH ?? process.arch
  if (!['arm64', 'x64'].includes(requestedArch)) {
    throw new Error(`unsupported macOS architecture: ${requestedArch}`)
  }
  // Intel 包允许在 Apple Silicon 上交叉打包（上游通用包亦如此），打包后的启动 smoke
  // 要靠 Rosetta 执行 x64 二进制；反过来 arm64 包在 Intel 机上没法跑 smoke，仍拒绝。
  if (!planOnly && process.arch !== requestedArch) {
    const rosetta = requestedArch === 'x64' && process.arch === 'arm64'
      && spawnSync('arch', ['-x86_64', '/usr/bin/true']).status === 0
    if (!rosetta) throw new Error(`macOS ${requestedArch} packaging requires a native ${requestedArch} Node runner (or Rosetta for x64)`)
  }
  return requestedArch
}

// 正式 macOS 模式由后续签名流程显式接管凭据；其余模式沿用调用环境。
const buildEnvironment = mode === 'mac' ? withoutMacReleaseSecrets(process.env) : process.env

/* ---------------------- 组装跨平台产品工作区 ---------------------- */
// 先验证所有 Git pin 与产品声明，再把只读来源复制到 staging 工作区。
run(
  process.execPath,
  [resolve(root, 'build', 'pipeline', 'repo-layout-verify.mjs'), '--require-clean'],
  root,
  buildEnvironment,
)
run(process.execPath, [resolve(root, 'build', 'pipeline', 'plugin-artifacts-fetch.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'pipeline', 'staging-prepare.mjs')], root, buildEnvironment)

// staging 必须严格复用已提交的产品锁文件；插件仅在 staging 中编译和裁剪。
run('corepack', ['yarn', 'install', '--immutable'], stage, buildEnvironment)
// 安装后应用网页抓取代理、压缩和 RPC 覆盖，再验证实际 RPC 生命周期。
run(process.execPath, [resolve(root, 'build', 'pipeline', 'staging-runtime-patch.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'modules', 'runtime', 'staging-rpc-smoke.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'pipeline', 'staging-plugins-compile.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'pipeline', 'staging-plugins-prune.mjs')], root, buildEnvironment)

// 许可证门禁必须早于任何可分发安装包的生成。
run(
  'corepack',
  ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:licenses'],
  stage,
  buildEnvironment,
)

/* -------------------------- 仅校验产品 --------------------------- */
if (mode === 'check') {
  phase = 'check'
  // 上游通用单元测试由被 pin 的提交负责；这里完整验收实际组装后的产品边界。
  run('corepack', ['yarn', 'workspace', 'dsh-community-fabric', 'check'], stage, buildEnvironment)
  run('corepack', ['yarn', 'workspace', 'dsh-community-market', 'check'], stage, buildEnvironment)
  configureProduct(buildEnvironment)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'build'], stage, buildEnvironment)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'typecheck'], stage, buildEnvironment)
  for (const script of ['verify:closure', 'verify:cli', 'verify:loader', 'verify:profile']) {
    run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', script], stage, buildEnvironment)
  }
  verifyProductBranding(buildEnvironment)
  // 插件真实宿主契约（T0047）：每个插件对装配好的宿主把它用到的接口各调一次；
  // 内置插件按 pin，市场插件按其仓库默认分支。任一红即门禁失败。
  run(process.execPath, [resolve(root, 'build', 'pipeline', 'plugin-host-contracts.mjs')], root, buildEnvironment)
  // 内置插件功能回归：每个内置插件在固定 pin 上跑自己的 test:cases，HOST 用例用上面装配好的宿主。
  // 以前是独立的 Windows 任务，没有 staging 就没有宿主，T0047 后那些用例全报未执行。
  run(process.execPath, [resolve(root, 'scripts', 'test-product-plugins.mjs'), '--fail-fast'], root, buildEnvironment)
} else if (mode === 'mac-unsigned') {
  phase = 'mac-unsigned'
  /* ----------------------- 未签名 macOS DMG ------------------------ */
  // 完整质量门禁由独立任务执行；本分支只构建未签名的原生验证包。
  const requestedArch = assertNativeMacArchitecture()
  configureBuildAndVerifyProduct(buildEnvironment, `mac-${requestedArch}`)
  prepareMacNativeRuntime([requestedArch], buildEnvironment)
  const packagingEnvironment = {
    ...buildEnvironment,
    DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY: '1',
    DSH_MAC_ARCH: requestedArch,
    // 2.0.18 起随包分发 Python/Node 解释器载荷；上游按通用包准备两个 CPU，单架构包只准备本架构。
    DSH_MAC_SMOKE_ARCH: requestedArch,
  }
  run('corepack', [
    'yarn',
    'workspace',
    'dsh-plugin-desktop',
    'exec',
    'electron-builder',
    '--mac',
    'dmg',
    `--${requestedArch}`,
    '--publish',
    'never',
    '--config.forceCodeSigning=false',
    '--config.mac.identity=null',
    '--config.mac.notarize=false',
    '--config.afterPack=./scripts/mac-unsigned-after-pack.ts',
  ], stage, packagingEnvironment)
} else if (mode === 'win') {
  phase = 'windows'
  /* ----------------------- Windows x64 安装包 ---------------------- */
  // Windows 安装器包含原生依赖，只允许在原生 x64 Windows Node 中组装。
  if (!planOnly && (process.platform !== 'win32' || process.arch !== 'x64')) {
    throw new Error('Windows installer packaging requires native Windows x64 Node')
  }
  const unsignedEnvironment = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    // Market 与 Desktop 测试会并发创建大量 Windows 文件；限制 worker 可避免
    // NTFS/Defender 负载下偶发的子进程启动超时，调用方仍可显式覆盖。
    VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '2',
    DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY: '1',
  }
  // 当前 Windows 产品只生成未签名安装包；清除所有可能触发自动签名的变量。
  for (const key of [
    'CSC_KEY_PASSWORD',
    'CSC_LINK',
    'CSC_NAME',
    'WIN_CSC_KEY_PASSWORD',
    'WIN_CSC_LINK',
  ]) delete unsignedEnvironment[key]
  // 产品质量门禁（Fabric、Market、上游 Windows 包测试、类型、CLI/Loader/Profile）
  // 由并行的 win-check 任务承担，发布任务等两者都通过；这里只装配、编译并打包，
  // 让 Windows 安装包不再排在门禁后面串行等 4 分钟。
  configureProduct(unsignedEnvironment, 'windows')
  // Market 原先由门禁里的 `dsh-community-market check` 顺带编译；拆开后这里要和
  // macOS 一样自己编 Market 与 Desktop，品牌校验读的是两者的产物。
  buildProduct(unsignedEnvironment)
  verifyProductBranding(unsignedEnvironment)
  // 2.0.18 起随包分发 Python/Node 解释器载荷（extraResources `.desktop-build/runtime`），上游在
  // package-win.ts 里先准备再打包；我们直接调 electron-builder，所以这里自己准备，afterPack 会校验它。
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'prepare:runtime'], stage, unsignedEnvironment)
  // 最终物理运行时由 Electron Builder afterPack 与 verify-package 检查。
  run('corepack', [
    'yarn',
    'workspace',
    'dsh-plugin-desktop',
    'exec',
    'electron-builder',
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    '--config.win.signExecutable=false',
    '--config.npmRebuild=false',
  ], stage, unsignedEnvironment)
  run(process.execPath, [resolve(root, 'build', 'pipeline', 'packaged-app-verify.mjs'), 'windows'], root)
} else if (mode === 'win-check') {
  phase = 'windows-check'
  /* ----------------------- Windows 质量门禁 ------------------------ */
  // 与 Windows 打包并行执行的完整产品门禁；复用同一套 staging 装配，避免 CI 先在
  // Linux 从零装配一次。Fabric 与 Market 完整检查不依赖产品品牌，先与上游 Windows
  // 安装包测试一起执行。
  if (!planOnly && (process.platform !== 'win32' || process.arch !== 'x64')) {
    throw new Error('Windows quality gates require native Windows x64 Node')
  }
  const gateEnvironment = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '2',
    DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY: '1',
  }
  run('corepack', ['yarn', 'workspace', 'dsh-community-fabric', 'check'], stage, gateEnvironment)
  run('corepack', ['yarn', 'workspace', 'dsh-community-market', 'check'], stage, gateEnvironment)
  // Windows 专项测试会验收 DSH Desktop 的原始版本和应用标识。通过后再注入
  // TokensCowork 品牌并重新编译，避免把正常的产品改写误报为上游回归。
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:win-package'], stage, gateEnvironment)
  configureProduct(gateEnvironment, 'windows')
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'build'], stage, gateEnvironment)
  verifyProductBranding(gateEnvironment)
  // 产品品牌会改写 TypeScript 与客户端 Logo 源码，因此在最终产品编译后保留
  // 类型、CLI、Loader 和 Profile 门禁。
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'typecheck'], stage, gateEnvironment)
  for (const script of ['verify:cli', 'verify:loader', 'verify:profile']) {
    run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', script], stage, gateEnvironment)
  }
  // 插件真实宿主契约（T0047）：预发布构建也跑，不再只在转稳定版时验插件。
  run(process.execPath, [resolve(root, 'build', 'pipeline', 'plugin-host-contracts.mjs')], root, gateEnvironment)
  // 内置插件功能回归放在同一个有 staging 宿主的任务里（见 check 模式的说明）。
  run(process.execPath, [resolve(root, 'scripts', 'test-product-plugins.mjs'), '--fail-fast'], root, gateEnvironment)
} else {
  phase = 'mac-signed'
  /* ----------------------- 正式 macOS 安装包 ----------------------- */
  // 通用质量门禁由同一次工作流的 Windows 任务负责；产品配置会移除上游
  // macOS 发布脚本中的重复 check，发布任务会等待全部平台构建通过。
  const signedArch = assertNativeMacArchitecture()
  configureBuildAndVerifyProduct(buildEnvironment, `mac-${signedArch}`)
  prepareMacNativeRuntime([signedArch], buildEnvironment)
  const releaseEnvironment = {
    ...(planOnly ? process.env : adaptAppleReleaseEnvironment(process.env)),
    DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY: '1',
    DSH_MAC_ARCH: signedArch,
    // 解释器载荷只准备并校验本架构那一份（上游默认按通用包准备两个 CPU）。
    DSH_MAC_SMOKE_ARCH: signedArch,
    TOKENS_MAC_RECOVERY_DIR: resolve(root, '.build', 'mac-recovery', signedArch),
  }
  run(
    'corepack',
    ['yarn', 'workspace', 'dsh-plugin-desktop', 'dist:mac'],
    stage,
    releaseEnvironment,
  )
}
