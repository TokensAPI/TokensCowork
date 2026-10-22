/* ============================================================
 * 插件真实宿主契约门禁（T0047 B）
 * ============================================================
 * staging 装配完成后，把每个插件的源码按固定提交隔离检出、安装依赖，
 * 以 `DSH_HOST_ROOT` 指向 staging 的宿主跑它自己的 `npm run check:host`。
 * 内置插件按 product.json 的 pin；市场插件按 build/pipeline/plugin-host-contracts.json
 * 列的仓库（本机有同级检出就用它的远端默认分支，否则直接克隆远端）。
 * 任何一个插件红、或有 agent 的插件没有 check:host 且不在豁免表里，门禁失败。
 * 用法：node build/pipeline/plugin-host-contracts.mjs [--plan] [--only <id,...>]
 * ============================================================ */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCommand, isolatedPackageEnvironment, outputTail, withGitBash } from '../../scripts/test-product-plugins.mjs'
import { productStage } from './paths.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stage = productStage(root)
export const HOST_ROOT = join(stage, 'dsh-plugin-desktop')
const CONFIG = join(root, 'build', 'pipeline', 'plugin-host-contracts.json')

function git(args, cwd = root) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}

function sh(command, args, cwd, env) {
  const windowsShim = process.platform === 'win32' && ['npm', 'corepack'].includes(command)
  const result = spawnSync(command, args, { cwd, env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: windowsShim })
  return { ...result, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

function must(result, label) {
  if (result.error || result.status !== 0) throw new Error(`${label} failed (${result.status ?? result.error?.code})${outputTail(result.output)}`)
  return result
}

/** 只读 Git 对象导出固定源码，不碰工作树。 */
function snapshot(source, commit, target) {
  mkdirSync(dirname(target), { recursive: true })
  must(sh('git', ['clone', '--shared', '--no-checkout', source, target], root, process.env), 'git clone')
  if (git(['cat-file', '-e', `${commit}^{commit}`], target).status !== 0) {
    must(sh('git', ['fetch', '--no-tags', 'origin', commit], target, process.env), 'git fetch')
  }
  const options = process.platform === 'win32' ? ['-c', 'core.symlinks=false'] : []
  must(sh('git', [...options, 'checkout', '--detach', commit], target, process.env), 'git checkout')
}

/** 市场插件：有本机同级检出就取它远端默认分支的最新提交，否则克隆远端。 */
function marketSource(entry) {
  const local = resolve(root, entry.local ?? '')
  if (entry.local && existsSync(join(local, '.git'))) {
    must(sh('git', ['fetch', '--quiet', 'origin'], local, process.env), `git fetch ${entry.id}`)
    const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], local)
    const branch = head.status === 0 ? head.stdout.trim() : 'origin/main'
    const commit = must(sh('git', ['rev-parse', '--verify', `${branch}^{commit}`], local, process.env), `git rev-parse ${entry.id}`).stdout.trim()
    return { source: local, commit, origin: `${entry.repository} (${branch})` }
  }
  const remote = must(sh('git', ['ls-remote', entry.repository, 'HEAD'], root, process.env), `git ls-remote ${entry.id}`).stdout
  const commit = remote.split(/\s+/)[0]
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Cannot resolve HEAD of ${entry.repository}`)
  return { source: entry.repository, commit, origin: `${entry.repository} (HEAD)` }
}

export function buildPlan({ product, config, only }) {
  const plan = []
  for (const plugin of product.plugins.filter(item => item.enabledByDefault)) {
    plan.push({ id: plugin.id, kind: 'builtin', source: join(root, plugin.path), commit: plugin.commit, package: plugin.package })
  }
  for (const entry of config.market ?? []) plan.push({ id: entry.id, kind: 'market', entry, package: entry.package })
  return only ? plan.filter(item => only.has(item.id)) : plan
}

export function parseOptions(args) {
  const options = { plan: false, only: undefined, pins: new Map() }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan') options.plan = true
    else if (args[i] === '--only' && args[i + 1]) options.only = new Set(args[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (args[i] === '--pin' && args[i + 1]) {
      // 把某个市场插件固定到指定提交复现（如排查某个已发版本）。注意它跑的是该提交自带的用例，
      // 不能用来验门禁分辨力：验分辨力要用当前用例套旧版源码（见 build/modules/README.md 升级第 3 步）。
      const [id, commit] = args[++i].split('=')
      if (!id || !/^[a-f0-9]{7,40}$/.test(commit ?? '')) throw new Error('--pin expects <id>=<commit>')
      options.pins.set(id, commit)
    } else throw new Error('Usage: plugin-host-contracts.mjs [--plan] [--only <id,...>] [--pin <id>=<commit>]')
  }
  return options
}

/** 契约命令的输出里每条用例一行；把 NOT EXECUTED 单独计数，便于看清是未执行还是失败。 */
export function summarize(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  const count = pattern => (text.match(pattern) ?? []).length
  return { pass: count(/\bPASS\b/g), fail: count(/\bFAIL\b/g), notExecuted: count(/NOT EXECUTED|未执行/g) }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8'))
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
  const plan = buildPlan({ product, config, only: options.only })
  if (options.plan) {
    console.log(JSON.stringify({ hostRoot: HOST_ROOT, plan: plan.map(({ id, kind, commit }) => ({ id, kind, commit })) }, null, 2))
    return
  }
  if (!existsSync(join(HOST_ROOT, 'package.json'))) throw new Error(`plugin-host-contracts: staged host missing at ${HOST_ROOT}; run the staging steps first`)
  const generated = join(root, '.build', 'plugin-host-contracts')
  mkdirSync(generated, { recursive: true })
  const runRoot = mkdtempSync(join(generated, 'run-'))
  const temporaryRoot = join(runRoot, 'tmp')
  mkdirSync(temporaryRoot)
  const results = []
  const report = () => writeFileSync(join(runRoot, 'report.json'), `${JSON.stringify({ hostRoot: HOST_ROOT, results }, null, 2)}\n`)
  for (const item of plan) {
    const result = { id: item.id, kind: item.kind, status: 'not-run' }
    results.push(result)
    try {
      let resolved = item.kind === 'market' ? marketSource(item.entry) : { source: item.source, commit: item.commit, origin: item.source }
      if (options.pins.has(item.id)) resolved = { ...resolved, commit: options.pins.get(item.id), origin: `${resolved.origin} pinned to ${options.pins.get(item.id)}` }
      result.commit = resolved.commit
      result.origin = resolved.origin
      const directory = join(runRoot, item.kind, item.id)
      snapshot(resolved.source, resolved.commit, directory)
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (manifest.name !== item.package) throw new Error(`package name ${manifest.name} differs from ${item.package}`)
      if (!manifest.scripts?.['check:host']) {
        const reason = config.exempt?.[item.id]
        if (!reason) throw new Error('no check:host script and not exempt (build/plugin-host-contracts.json)')
        Object.assign(result, { status: 'exempt', reason })
        report()
        continue
      }
      console.log(`\n==> ${item.id} (${item.kind}) ${resolved.commit.slice(0, 7)}: npm run check:host`)
      const env = isolatedPackageEnvironment(withGitBash({ ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot }))
      const [command, installArgs] = installCommand(directory, manifest)
      must(sh(command, installArgs, directory, env), `${item.id} install`)
      const run = sh('npm', ['run', 'check:host'], directory, { ...env, DSH_HOST_ROOT: HOST_ROOT })
      process.stdout.write(run.stdout ?? '')
      process.stderr.write(run.stderr ?? '')
      result.summary = summarize(run.output)
      if (run.error || run.status !== 0) throw new Error(`check:host exited ${run.status ?? run.error?.code}${outputTail(run.output, 20)}`)
      result.status = 'passed'
    } catch (error) {
      result.status = 'failed'
      result.error = error.message
    }
    report()
  }
  const failed = results.filter(item => item.status === 'failed')
  console.log(`\nplugin-host-contracts: ${results.length} plugins, ${results.filter(r => r.status === 'passed').length} passed, ${results.filter(r => r.status === 'exempt').length} exempt, ${failed.length} failed. Report: ${join(runRoot, 'report.json')}`)
  if (failed.length > 0) throw new Error(`plugin host contracts failed: ${failed.map(item => `${item.id}: ${item.error.split('\n')[0]}`).join('; ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1) })
}
