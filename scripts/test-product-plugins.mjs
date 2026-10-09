import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 复用插件已有入口，没有测试脚本时明确排除，不伪造通过。 */
export function testScript(manifest) {
  if (manifest.scripts?.['test:cases']) return 'test:cases'
  return manifest.scripts?.test ? 'test' : undefined
}

export function installCommand(directory, manifest) {
  if (existsSync(join(directory, 'package-lock.json'))) return ['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']]
  if (existsSync(join(directory, 'pnpm-lock.yaml'))) {
    const manager = manifest.packageManager?.startsWith('pnpm@') ? manifest.packageManager : 'pnpm@11.7.0'
    return ['corepack', [manager, 'install', '--frozen-lockfile', '--ignore-scripts']]
  }
  return ['npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund']]
}

export function assertCompleteTestOutput(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  if (/^INCOMPLETE\s|^\s*(?:#|ℹ)?\s*(?:skipped|todo)\s+[1-9]\d*\b|\b[1-9]\d*\s+(?:skipped|todo)\b/im.test(text)) {
    throw new Error('Test runner reported incomplete, skipped or TODO tests')
  }
}

function run(command, args, cwd, env = process.env, testRun = false) {
  // Windows 的 npm/corepack 是 cmd shim；参数由本脚本生成，不拼接用户命令。
  const windowsShim = process.platform === 'win32' && ['npm', 'corepack'].includes(command)
  const result = spawnSync(command, args, { cwd, env: { ...env, COREPACK_ENABLE_PROJECT_SPEC: '0' }, stdio: testRun ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: windowsShim, timeout: 20 * 60_000 })
  if (testRun) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
  }
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.code})`)
  if (testRun) assertCompleteTestOutput(`${result.stdout}\n${result.stderr}`)
}

function git(args, cwd = root) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}

/** 只读 Git 对象导出固定源码；依赖与测试产物全部落在 .build 中。 */
function snapshot(source, commit, target) {
  mkdirSync(dirname(target), { recursive: true })
  run('git', ['clone', '--shared', '--no-checkout', source, target], root)
  if (git(['cat-file', '-e', `${commit}^{commit}`], target).status !== 0) {
    run('git', ['fetch', '--no-tags', 'origin', commit], target)
  }
  // Windows Git 将源码符号链接作为文本检出，避免 tar 对链接权限的依赖。
  const options = process.platform === 'win32' ? ['-c', 'core.symlinks=false'] : []
  run('git', [...options, 'checkout', '--detach', commit], target)
}

export function parseOptions(args) {
  const options = { ref: 'HEAD', plan: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan') options.plan = true
    else if (args[i] === '--ref' && args[i + 1] && !args[i + 1].startsWith('-')) options.ref = args[++i]
    else throw new Error('Usage: test-product-plugins.mjs [--ref <tag>] [--plan]')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(options.ref)) throw new Error('Invalid Git ref')
  return options
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const resolved = git(['rev-parse', '--verify', `${options.ref}^{commit}`])
  if (resolved.status !== 0) throw new Error(`Cannot resolve ${options.ref}`)
  const commit = resolved.stdout.trim()
  const manifestResult = git(['show', `${commit}:product.json`])
  if (manifestResult.status !== 0) throw new Error('Missing product.json at selected ref')
  const product = JSON.parse(manifestResult.stdout)
  const plugins = product.plugins.filter(plugin => plugin.enabledByDefault)
  const plan = plugins.map(plugin => {
    if (!/^plugins\/[a-zA-Z0-9_-]+$/.test(plugin.path) || !/^[a-f0-9]{40}$/.test(plugin.commit)) throw new Error(`Invalid plugin pin: ${plugin.id}`)
    const source = join(root, plugin.path)
    const result = git(['show', `${plugin.commit}:package.json`], source)
    if (result.status !== 0) throw new Error(`Missing source for ${plugin.id}; initialize submodules recursively`)
    const manifest = JSON.parse(result.stdout)
    if (manifest.name !== plugin.package || manifest.version !== plugin.version) throw new Error(`Plugin identity differs from product pin: ${plugin.id}`)
    return { ...plugin, manifest, script: testScript(manifest) }
  })
  if (options.plan) {
    console.log(JSON.stringify({ ref: options.ref, commit, plugins: plan.map(({ id, version, commit, script }) => ({ id, version, commit, script: script ?? 'not configured' })) }, null, 2))
    return
  }
  if (!plan.some(plugin => plugin.script)) throw new Error('No configured plugin tests')
  const generated = join(root, '.build', 'plugin-tests')
  mkdirSync(generated, { recursive: true })
  const runRoot = mkdtempSync(join(generated, 'run-'))
  const outerRoot = join(runRoot, 'outer')
  snapshot(root, commit, outerRoot)
  const results = []
  const report = () => writeFileSync(join(runRoot, 'report.json'), JSON.stringify({ ref: options.ref, commit, results }, null, 2) + '\n')
  // 宿主集成用例需要真实固定 Harness；准备隔离副本，不能写源码子模块。
  const hostPlugins = new Set(['tokens-dsh-web-search', 'tokens-model-manager'])
  let hostError
  const runtimeRoot = join(outerRoot, 'desktop', 'deepseek-harness', 'apps', 'cli')
  if (plan.some(plugin => hostPlugins.has(plugin.id) && plugin.script)) {
    try {
      const desktop = join(outerRoot, 'desktop')
      snapshot(join(root, product.desktop.path), product.desktop.commit, desktop)
      const harness = join(desktop, 'deepseek-harness')
      snapshot(join(root, product.desktop.path, 'deepseek-harness'), product.desktop.deepseekHarnessCommit, harness)
      const hostManifest = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8'))
      const [command, args] = installCommand(harness, hostManifest)
      run(command, args, harness)
      if (plan.some(plugin => plugin.id === 'tokens-model-manager' && plugin.script)) {
        run('corepack', ['pnpm@11.7.0', 'run', 'build:lib:host'], harness)
      }
    } catch (error) { hostError = error.message }
  }
  for (const plugin of plan) {
    const result = { id: plugin.id, version: plugin.version, commit: plugin.commit, script: plugin.script, status: 'not-configured' }
    results.push(result)
    if (!plugin.script) { report(); continue }
    console.log(`\n==> ${plugin.id}@${plugin.version}: ${plugin.script} (${plugin.commit})`)
    try {
      if (hostPlugins.has(plugin.id) && hostError) throw new Error(`Host preparation failed: ${hostError}`)
      const directory = join(outerRoot, plugin.path)
      snapshot(join(root, plugin.path), plugin.commit, directory)
      const [command, args] = installCommand(directory, plugin.manifest)
      run(command, args, directory)
      const env = { ...process.env, TOKENS_OUTER_ROOT: outerRoot, TOKENS_HARNESS_ROOT: outerRoot, DSH_RUNTIME_ROOT: runtimeRoot }
      run('npm', ['run', plugin.script], directory, env, true)
      const functionalReport = join(directory, 'test-output', 'functional-cases-latest.json')
      if (existsSync(functionalReport)) {
        const details = JSON.parse(readFileSync(functionalReport, 'utf8'))
        result.caseSummary = details.summary
        result.testSummary = details.vitest
      }
      result.status = 'passed'
    } catch (error) {
      result.status = 'failed'
      result.error = error.message
    }
    report()
  }
  console.log(`\nReport: ${join(runRoot, 'report.json')}`)
  for (const result of results) console.log(`${result.id}: ${result.status}${result.error ? ' — ' + result.error : ''}`)
  if (results.some(result => result.status === 'failed')) throw new Error('Plugin regression failed; promotion is blocked')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
