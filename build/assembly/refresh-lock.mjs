import { copyFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..', '..')
const stage = resolve(root, '.build', 'refresh-lock')

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

function quoteCmdArgument(value) {
  if (/^[A-Za-z0-9:._@/=-]+$/u.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

const refreshEnvironment = {
  ...process.env,
  PRODUCT_REFRESH_LOCK: '1',
}
run(process.execPath, [resolve(root, 'build', 'plugins', 'fetch-artifacts.mjs')], root, refreshEnvironment)
run(process.execPath, [resolve(root, 'build', 'assembly', 'prepare.mjs')], root, refreshEnvironment)
run('corepack', ['yarn', 'install', '--mode=update-lockfile'], stage)
copyFileSync(resolve(stage, 'yarn.lock'), resolve(root, 'build', 'product.yarn.lock'))
rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
process.stdout.write('refresh-lock: wrote build/product.yarn.lock\n')
