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
run(process.execPath, [resolve(root, 'build', 'pipeline', 'plugin-artifacts-fetch.mjs')], root, refreshEnvironment)
run(process.execPath, [resolve(root, 'build', 'pipeline', 'staging-prepare.mjs')], root, refreshEnvironment)
// update-lockfile 只补缺、不收敛：旧锁里满足范围的老版本会一直留着。product.json 里插件注入的
// 共享依赖（如 schemastery）范围要和上游声明一致，否则同一包会并存两份（v0.7.0 时 3.18.4 / 3.18.5
// 各一份，TypeScript 认不出唯一的 Schema）。yarn dedupe 在 update-lockfile 模式下只报告不落盘，不能用。
run('corepack', ['yarn', 'install', '--mode=update-lockfile'], stage)
copyFileSync(resolve(stage, 'yarn.lock'), resolve(root, 'build', 'pipeline', 'product.yarn.lock'))
rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
process.stdout.write('refresh-lock: wrote build/pipeline/product.yarn.lock\n')
