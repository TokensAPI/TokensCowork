import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installCommand, run, runPluginTests, testScript } from './test-product-plugins.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Profile 里由市场安装的插件：排除上游运行时包和产品内置插件。
 * @param profileManifest - Profile 目录下 package.json 的内容。
 * @param builtinPackages - product.json 中内置插件的包名。
 * @returns 市场插件包名，保持 Profile 中的顺序。
 */
export function marketBundles(profileManifest, builtinPackages) {
  const bundles = profileManifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  const builtin = new Set(builtinPackages)
  return bundles.filter(name => typeof name === 'string' && !name.startsWith('@deepseek-ai/') && !builtin.has(name))
}

/** package.json 的 repository 字段转成可克隆地址；无法识别时返回 undefined。 */
export function repositoryUrl(manifest) {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (typeof raw !== 'string' || raw === '') return undefined
  const github = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw)
  if (github) return `https://github.com/${github[1]}.git`
  return raw.replace(/^git\+/, '')
}

/** 已安装版本对应的源码标签候选，按常见发布约定排列。 */
export function tagCandidates(version) {
  return [`v${version}`, version]
}

export function parseOptions(args) {
  const options = { profile: undefined, plan: false, failFast: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan') options.plan = true
    else if (args[i] === '--fail-fast') options.failFast = true
    else if (args[i] === '--profile' && args[i + 1] && !args[i + 1].startsWith('-')) options.profile = args[++i]
    else throw new Error('Usage: test-market-plugins.mjs --profile <dir> [--plan] [--fail-fast]')
  }
  if (options.profile === undefined) throw new Error('--profile <dir> is required')
  return options
}

/** 按已安装版本的标签浅克隆源码；仓库或标签缺失时返回原因，不伪造通过。 */
function checkout(url, version, target) {
  for (const tag of tagCandidates(version)) {
    const result = spawnSync('git', ['clone', '--depth', '1', '--branch', tag, url, target], { encoding: 'utf8' })
    if (result.status === 0) return { tag }
  }
  return { error: `no tag ${tagCandidates(version).join(' / ')} in ${url}` }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const profileManifest = JSON.parse(readFileSync(join(options.profile, 'package.json'), 'utf8'))
  const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8'))
  const names = marketBundles(profileManifest, product.plugins.map(plugin => plugin.package))
  const plan = names.map(name => {
    const manifestPath = join(options.profile, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(manifestPath)) return { id: name, version: 'missing', commit: '', script: undefined, error: 'not installed in Profile' }
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return { id: name, version: installed.version, commit: '', url: repositoryUrl(installed), script: 'pending' }
  })
  if (options.plan) {
    console.log(JSON.stringify({ profile: options.profile, plugins: plan.map(({ id, version, url }) => ({ id, version, repository: url ?? 'unknown' })) }, null, 2))
    return
  }
  if (plan.length === 0) {
    console.log('No market plugins installed in this Profile.')
    return
  }
  const generated = join(root, '.build', 'plugin-tests')
  mkdirSync(generated, { recursive: true })
  const runRoot = mkdtempSync(join(generated, 'market-'))
  const temporaryRoot = join(runRoot, 'tmp')
  mkdirSync(temporaryRoot)
  const report = results => writeFileSync(join(runRoot, 'report.json'), JSON.stringify({ profile: options.profile, results }, null, 2) + '\n')
  const results = runPluginTests(plan, plugin => {
    console.log(`\n==> ${plugin.id}@${plugin.version}`)
    // 拿不到源码只说明无法验证，记为未测而不是失败；测试本身失败才阻断。
    if (plugin.error) return { skipped: plugin.error }
    if (!plugin.url) return { skipped: 'package.json has no repository' }
    const directory = join(runRoot, plugin.id.replace(/[@/]/g, '_'))
    const source = checkout(plugin.url, plugin.version, directory)
    if (source.error) return { skipped: source.error }
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const script = testScript(manifest)
    if (!script) return { tag: source.tag, script: 'not configured' }
    const [command, commandArgs] = installCommand(directory, manifest)
    run(command, commandArgs, directory)
    run('npm', ['run', script], directory, { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot }, true)
    return { tag: source.tag, script }
  }, report, options)
  for (const result of results) if (result.skipped) Object.assign(result, { status: 'not-run', error: result.skipped })
  report(results)
  console.log(`\nReport: ${join(runRoot, 'report.json')}`)
  for (const result of results) console.log(`${result.id}@${result.version}: ${result.status}${result.script === 'not configured' ? ' (no test script)' : ''}${result.error ? ' — ' + result.error : ''}`)
  if (results.some(result => result.status === 'failed')) throw new Error('Market plugin tests failed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
