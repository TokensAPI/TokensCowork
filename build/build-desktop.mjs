import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stage = resolve(root, '.build', 'desktop')
const mode = process.argv[2]
if (!['check', 'win', 'mac', 'mac-unsigned'].includes(mode)) {
  throw new Error('build-desktop: expected check, win, mac, or mac-unsigned')
}

function run(command, args, cwd) {
  const windowsCorepack = process.platform === 'win32' && command === 'corepack'
  const executable = windowsCorepack
    ? process.env.ComSpec ?? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    : command
  const resolvedArgs = windowsCorepack
    ? ['/d', '/s', '/c', `corepack ${args.map(quoteCmdArgument).join(' ')}`]
    : args
  const result = spawnSync(executable, resolvedArgs, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

function quoteCmdArgument(value) {
  if (/^[A-Za-z0-9:._@/=-]+$/u.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

run(process.execPath, [resolve(root, 'build', 'verify-layout.mjs')], root)
run(process.execPath, [resolve(root, 'build', 'prepare-desktop.mjs')], root)
run('corepack', ['yarn', 'install', '--immutable'], stage)
run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:licenses'], stage)

if (mode === 'check') {
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'build'], stage)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'typecheck'], stage)
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:closure'], stage)
} else if (mode === 'mac-unsigned') {
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'check'], stage)
  run('corepack', [
    'yarn',
    'workspace',
    'dsh-plugin-desktop',
    'exec',
    'electron-builder',
    '--mac',
    'dmg',
    '--arm64',
    '--publish',
    'never',
    '--config.forceCodeSigning=false',
    '--config.mac.identity=null',
    '--config.mac.notarize=false',
  ], stage)
} else {
  run('corepack', ['yarn', mode === 'win' ? 'dist:win' : 'dist:mac'], stage)
}
