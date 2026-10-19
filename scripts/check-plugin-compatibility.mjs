/* ============================================================
 * 插件兼容速查（秒级，不跑插件测试）
 * ============================================================
 * 回答一个问题：装在 Profile 里的插件，在本次要启动的运行时上
 * 会不会被宿主停用。判定不自己实现，直接调用 staging 里宿主自己
 * 的 evaluatePluginCompatibility，口径与真实启动完全一致。
 *
 * 用法：
 *   node scripts/check-plugin-compatibility.mjs [--profile <目录>] [--json]
 *   启动脚本的 -CheckPlugins 开关会调用它。
 *
 * 退出码：有插件会被停用时为 1，其余为 0。
 * ============================================================ */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { productStage } from '../build/pipeline/paths.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function parseOptions(args) {
  const options = { profile: undefined, json: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') options.json = true
    else if (args[i] === '--profile' && args[i + 1] && !args[i + 1].startsWith('-')) options.profile = args[++i]
    else throw new Error('Usage: check-plugin-compatibility.mjs [--profile <dir>] [--json]')
  }
  return options
}

/** 默认 Profile：真实数据模式下与应用共用的那一个。 */
export function defaultProfile(home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')) {
  return join(home, 'profiles', 'desktop')
}

/** Profile 里登记为 bundle 的插件；缺失清单时返回空列表而不是报错。 */
export function profilePlugins(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const bundles = JSON.parse(readFileSync(manifestPath, 'utf8')).dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter(name => typeof name === 'string').map(name => ({
    name,
    manifestPath: join(profileDir, 'node_modules', ...name.split('/'), 'package.json'),
  }))
}

/** 产品内置插件：它们随安装包发布，装配目录即真相。 */
export function stagedPlugins(stage) {
  const pluginsRoot = join(stage, 'dsh-plugin-desktop', 'product-plugins')
  if (!existsSync(pluginsRoot)) return []
  return readdirSync(pluginsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, manifestPath: join(pluginsRoot, entry.name, 'package.json') }))
}

/** 一行判定结果；peers 只保留导致停用的那几项，便于直接看出要改什么。 */
export function evaluate(evaluatePluginCompatibility, entries, runtimeVersion) {
  return entries.map(({ name, manifestPath }) => {
    if (!existsSync(manifestPath)) return { name, status: 'missing' }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const version = typeof manifest.version === 'string' ? manifest.version : '?'
    try {
      const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
      return issue === undefined
        ? { name, version, status: 'ok' }
        : { name, version, status: 'blocked', peers: issue.peers, exempted: issue.exempted === true }
    } catch (error) {
      return { name, version, status: 'error', message: error.message }
    }
  })
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const stage = productStage(root)
  const bootPath = join(stage, 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  if (!existsSync(bootPath)) throw new Error(`装配目录里没有宿主运行时，先装配一次：${bootPath}`)
  const { evaluatePluginCompatibility } = await import(pathToFileURL(bootPath).href)
  const runtimeVersion = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8')).desktop.runtimeVersion
  const profile = options.profile ?? defaultProfile()

  const results = [
    ...evaluate(evaluatePluginCompatibility, stagedPlugins(stage), runtimeVersion).map(r => ({ ...r, kind: '内置' })),
    ...evaluate(evaluatePluginCompatibility, profilePlugins(profile), runtimeVersion).map(r => ({ ...r, kind: '已装' })),
  ].filter(result => !(result.kind === '已装' && result.name.startsWith('@deepseek-ai/')))

  const blocked = results.filter(result => result.status === 'blocked')
  if (options.json) {
    console.log(JSON.stringify({ runtimeVersion, profile, results }, null, 2))
  } else {
    console.log(`插件兼容速查 · 运行时 ${runtimeVersion} · Profile ${profile}\n`)
    for (const result of results) {
      const mark = { ok: '✔', blocked: '✖', missing: '○', error: '!' }[result.status]
      const detail = result.status === 'blocked' ? ` 会被停用：peer ${JSON.stringify(result.peers)}`
        : result.status === 'missing' ? ' 未安装'
          : result.status === 'error' ? ` 清单无法判定：${result.message}` : ''
      console.log(`  ${mark} ${result.kind} ${result.name}${result.version ? `@${result.version}` : ''}${detail}`)
    }
    console.log(blocked.length === 0
      ? '\n没有插件会被停用。'
      : `\n${blocked.length} 个插件会在启动时被停用：更新到兼容 ${runtimeVersion} 的版本，或在插件市场更新。`)
  }
  if (blocked.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
