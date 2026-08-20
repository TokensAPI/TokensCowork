import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stage = resolve(root, '.build', 'desktop')
const mode = process.argv[2]
if (!['check', 'win', 'mac', 'mac-unsigned'].includes(mode)) {
  throw new Error('build-desktop: expected check, win, mac, or mac-unsigned')
}

const MAC_RELEASE_VARIABLES = [
  'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE', 'APPLE_TEAM_ID', 'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_NAME', 'MACOS_SIGN_IDENTITY',
  'MAC_CERT_P12_BASE64',
]

function withoutMacReleaseSecrets(environment) {
  const sanitized = { ...environment }
  for (const name of MAC_RELEASE_VARIABLES) delete sanitized[name]
  return sanitized
}

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

function configureBuildAndVerifyProduct(environment = process.env) {
  run(process.execPath, [resolve(root, 'build', 'configure-product.mjs')], root, environment)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'build'], stage, environment)
  run(process.execPath, [resolve(root, 'build', 'verify-product-branding.mjs')], root, environment)
}

function quoteCmdArgument(value) {
  if (/^[A-Za-z0-9:._@/=-]+$/u.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

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

const buildEnvironment = mode === 'mac' ? withoutMacReleaseSecrets(process.env) : process.env

run(process.execPath, [resolve(root, 'build', 'verify-layout.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'fetch-product-plugin-artifacts.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'prepare-desktop.mjs')], root, buildEnvironment)
run('corepack', ['yarn', 'install', '--immutable'], stage, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'compile-product-plugins.mjs')], root, buildEnvironment)
run(process.execPath, [resolve(root, 'build', 'prune-product-plugins.mjs')], root, buildEnvironment)
run(
  'corepack',
  ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:licenses'],
  stage,
  buildEnvironment,
)

if (mode === 'check') {
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'build'], stage)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'typecheck'], stage)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:closure'], stage)
  configureBuildAndVerifyProduct(buildEnvironment)
} else if (mode === 'mac-unsigned') {
  const requestedArch = assertNativeMacArchitecture()
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'check'], stage)
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
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows installer packaging requires native Windows x64 Node')
  }
  const unsignedEnvironment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  for (const key of [
    'CSC_KEY_PASSWORD',
    'CSC_LINK',
    'CSC_NAME',
    'WIN_CSC_KEY_PASSWORD',
    'WIN_CSC_LINK',
  ]) delete unsignedEnvironment[key]
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
  assertNativeMacArchitecture()
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'check'], stage, buildEnvironment)
  configureBuildAndVerifyProduct(buildEnvironment)
  run('corepack', ['yarn', 'dist:mac'], stage)
}
