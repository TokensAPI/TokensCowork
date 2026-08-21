import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/* ====================================================================
 * TokensHarness 桌面产品构建入口
 *
 * 所有模式都先在 `.build/desktop` 组装只读上游与产品插件，再按目标执行
 * 校验或原生打包。构建过程不得修改 desktop/ 与 plugins/ 子模块工作树。
 * ==================================================================== */

const root = resolve(import.meta.dirname, '..')
const stage = resolve(root, '.build', 'desktop')
const mode = process.argv[2]
if (!['check', 'win', 'mac', 'mac-unsigned'].includes(mode)) {
  throw new Error('build-desktop: expected check, win, mac, or mac-unsigned')
}

// 未签名或本地 macOS 构建不得继承正式发布凭据，避免构建工具自动选择
// Developer ID 签名、钥匙串身份或公证流程。
const MAC_RELEASE_VARIABLES = [
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
  const windowsCorepack = process.platform === 'win32' && command === 'corepack'
  const executable = windowsCorepack
    ? process.env.ComSpec ?? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    : command
  const resolvedArgs = windowsCorepack
    ? ['/d', '/s', '/c', `corepack ${args.map(quoteCmdArgument).join(' ')}`]
    : args
  const result = spawnSync(executable, resolvedArgs, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/** 将产品品牌和发布配置写入 staging 工作区。 */
function configureProduct(environment = process.env) {
  run(process.execPath, [resolve(root, 'build', 'configure-product.mjs')], root, environment)
}

/** 编译 staging 中完整的桌面产品 workspace。 */
function buildProduct(environment = process.env) {
  run('corepack', ['yarn', 'run', 'build'], stage, environment)
}

/** 验证产品品牌已经进入源码配置与编译后的运行时闭包。 */
function verifyProductBranding(environment = process.env) {
  run(process.execPath, [resolve(root, 'build', 'verify-product-branding.mjs')], root, environment)
}

/** 配置、编译并验收一个可供平台打包器消费的产品工作区。 */
function configureBuildAndVerifyProduct(environment = process.env) {
  configureProduct(environment)
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
  if (process.platform !== 'darwin') throw new Error('macOS packaging requires macOS')
  const requestedArch = process.env.DSH_MAC_ARCH ?? process.arch
  if (!['arm64', 'x64'].includes(requestedArch)) {
    throw new Error(`unsupported macOS architecture: ${requestedArch}`)
  }
  if (process.arch !== requestedArch) {
    throw new Error(`macOS ${requestedArch} packaging requires a native ${requestedArch} Node runner`)
  }
  return requestedArch
}

// 正式 macOS 模式由后续签名流程显式接管凭据；其余模式沿用调用环境。
const buildEnvironment = mode === 'mac' ? withoutMacReleaseSecrets(process.env) : process.env

/* ---------------------- 组装跨平台产品工作区 ---------------------- */
// 先验证所有 Git pin 与产品声明，再把只读来源复制到 staging 工作区。
run(process.execPath, [resolve(root, 'build', 'verify-layout.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'fetch-product-plugin-artifacts.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'prepare-desktop.mjs')], root, buildEnvironment)

// staging 必须严格复用已提交的产品锁文件；插件仅在 staging 中编译和裁剪。
run('corepack', ['yarn', 'install', '--immutable'], stage, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'compile-product-plugins.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'prune-product-plugins.mjs')], root, buildEnvironment)

// 许可证门禁必须早于任何可分发安装包的生成。
run(
  'corepack',
  ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:licenses'],
  stage,
  buildEnvironment,
)

/* -------------------------- 仅校验产品 --------------------------- */
if (mode === 'check') {
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
} else if (mode === 'mac-unsigned') {
  /* ----------------------- 未签名 macOS DMG ------------------------ */
  // 完整质量门禁由独立任务执行；本分支只构建未签名的原生验证包。
  const requestedArch = assertNativeMacArchitecture()
  configureBuildAndVerifyProduct(buildEnvironment)
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
  ], stage)
} else if (mode === 'win') {
  /* ----------------------- Windows x64 安装包 ---------------------- */
  // Windows 安装器包含原生依赖，只允许在原生 x64 Windows Node 中组装。
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows installer packaging requires native Windows x64 Node')
  }
  const unsignedEnvironment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  // 当前 Windows 产品只生成未签名安装包；清除所有可能触发自动签名的变量。
  for (const key of [
    'CSC_KEY_PASSWORD',
    'CSC_LINK',
    'CSC_NAME',
    'WIN_CSC_KEY_PASSWORD',
    'WIN_CSC_LINK',
  ]) delete unsignedEnvironment[key]
  // 先在未改写的上游工作区执行 Windows 安装包测试；这些测试会验收
  // DSH Desktop 的原始版本和应用标识。通过后再注入 TokensHarness 品牌并重新编译，
  // 避免把产品版本误报为上游回归。
  run('corepack', ['yarn', 'workspace', 'dsh-community-market', 'build'], stage, unsignedEnvironment)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:win-package'], stage, unsignedEnvironment)
  configureBuildAndVerifyProduct(unsignedEnvironment)
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
  run(process.execPath, [resolve(root, 'build', 'verify-package.mjs'), 'windows'], root)
} else {
  /* ----------------------- 正式 macOS 安装包 ----------------------- */
  // 通用质量门禁由独立任务负责；产品配置会移除上游发布脚本中的重复 check。
  assertNativeMacArchitecture()
  configureBuildAndVerifyProduct(buildEnvironment)
  run(
    'corepack',
    ['yarn', 'workspace', 'dsh-plugin-desktop', 'dist:mac'],
    stage,
    process.env,
  )
}
