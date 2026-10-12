/* ====================================================================
 * 覆盖清单与升级体检（yarn product:overlays）
 *
 *   yarn product:overlays [模块]          列出覆盖：阶段、目标文件、原因、删除条件、验证证据
 *   yarn product:overlays [模块] --check  校验登记完整性，并报告固定输入（pin）变化；CI 使用
 *   yarn product:overlays --file <路径>   反查哪些覆盖修改了这个 staging 文件、按什么顺序
 *   yarn product:overlays --doctor        在临时 staging 中逐条执行覆盖，判定可删 / 要改，
 *                                         并列出 pin 变化后被覆盖文件的上游改动
 *
 * 覆盖登记在 modules/<模块>/overlays.mjs；pin 基线与验证证据在同目录 review.json。
 * ==================================================================== */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStageFiles, loadOverlays, modules, phases, runOverlays } from './overlay-engine.mjs'
import { productStage } from './paths.mjs'

const root = resolve(import.meta.dirname, '..', '..')

/* ----------------------------- 固定输入 ----------------------------- */

const pin = plugin => plugin ? { commit: plugin.commit, version: plugin.version, artifact: plugin.artifact?.sha256 ?? null } : null

/** 当前 product.json 的固定输入，与 review.json 的 baseline 同结构。 */
export function currentPins(product) {
  return {
    desktop: product.desktop.commit,
    dsh: { commit: product.desktop.deepseekHarnessCommit, version: product.desktop.runtimeVersion },
    plugins: Object.fromEntries(product.plugins.map(plugin => [plugin.id, pin(plugin)])),
  }
}

/** 覆盖的哪些固定输入相对基线变了；market-server / product 没有独立 pin。 */
export function pinChanges(overlay, baseline, current) {
  const changed = []
  for (const input of overlay.upstream) {
    if (input === 'desktop' && baseline.desktop !== current.desktop) changed.push(input)
    if (input === 'dsh' && JSON.stringify(baseline.dsh) !== JSON.stringify(current.dsh)) changed.push(input)
    if (input.startsWith('plugin:')) {
      const id = input.slice('plugin:'.length)
      if (JSON.stringify(baseline.plugins?.[id] ?? null) !== JSON.stringify(current.plugins[id] ?? null)) changed.push(input)
    }
  }
  return changed
}

/* ----------------------------- 登记数据 ----------------------------- */

export function loadReviews(base = root) {
  return Object.fromEntries(modules.map(module => [module,
    JSON.parse(readFileSync(resolve(base, 'build/modules', module, 'review.json'), 'utf8'))]))
}

async function loadChecks(base = root) {
  const checks = []
  for (const module of modules) {
    const registry = await import(pathToFileURL(resolve(base, 'build/modules', module, 'overlays.mjs')).href)
    for (const check of registry.checks ?? []) checks.push({ ...check, module })
  }
  return checks
}

/** 覆盖修改的 staging 路径；动态目标按上游源码解析。 */
export function overlayTargets(overlay, product, base = root) {
  if (overlay.copy !== undefined) {
    const copies = typeof overlay.copy === 'function' ? overlay.copy({ product }) : overlay.copy
    return copies.map(([, target]) => target)
  }
  if (overlay.run !== undefined) return overlay.targets ?? []
  const files = typeof overlay.files === 'function'
    ? overlay.files({ product, files: createStageFiles(resolve(base, 'desktop')) })
    : overlay.files
  return Object.values(files).map(spec => typeof spec === 'string' ? spec : spec.path)
}

/** 模块目录内文件的静态 import（相对路径），用于发现未接入的历史代码。 */
function localImports(path) {
  const source = readFileSync(path, 'utf8')
  return [...source.matchAll(/\bfrom\s+['"](\.\/[^'"]+)['"]|import\(\s*['"](\.\/[^'"]+)['"]\s*\)/gu)]
    .map(match => resolve(dirname(path), match[1] ?? match[2]))
}

/**
 * 登记完整性：每个覆盖结构合法；模块里的实现文件都能从登记表到达（被引用、
 * 被复制或登记为检查脚本）；验证证据只引用存在的覆盖。
 */
export async function validateRegistry(base = root) {
  const overlays = await loadOverlays(base)
  const checks = await loadChecks(base)
  const reviews = loadReviews(base)
  const ids = new Set(overlays.map(overlay => overlay.id))
  for (const module of modules) {
    const directory = resolve(base, 'build/modules', module)
    const registryPath = resolve(directory, 'overlays.mjs')
    const registrySource = readFileSync(registryPath, 'utf8')
    const reached = new Set([registryPath])
    const queue = [registryPath]
    while (queue.length) {
      for (const path of localImports(queue.pop())) {
        if (!reached.has(path) && existsSync(path)) { reached.add(path); queue.push(path) }
      }
    }
    for (const check of checks.filter(item => item.module === module)) {
      const path = resolve(directory, check.file)
      assert.ok(existsSync(path), `${module}: 检查脚本不存在 ${check.file}`)
      reached.add(path)
    }
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory()) {
        assert.equal(item.name, 'assets', `${module}: 只允许 assets/ 子目录，发现 ${item.name}/`)
        continue
      }
      if (['overlays.mjs', 'review.json', 'README.md'].includes(item.name) || item.name.endsWith('.test.mjs')) continue
      const path = resolve(directory, item.name)
      // 复制或拼接进 staging 的模板（.spec.ts / .inc / .ts）由登记表按文件名引用。
      const referenced = reached.has(path) || registrySource.includes(`'${item.name}'`)
      assert.ok(referenced, `${module}: ${item.name} 没有被登记表引用，也不是检查脚本——未接入的代码应删除或登记`)
    }
    const review = reviews[module]
    assert.ok(review, `${module}: 缺少 review.json`)
    assert.equal(review.schemaVersion, 2, `${module}: review.json schemaVersion 应为 2`)
    for (const item of review.evidence) {
      for (const id of item.overlays) assert.ok(ids.has(id), `${module}: review.json 引用了不存在的覆盖 ${id}`)
    }
  }
  // 本地开发脚本按需先 configure 再编译插件，正式构建相反；两阶段不得改同一文件，顺序才无关。
  const product = JSON.parse(readFileSync(resolve(base, 'product.json'), 'utf8'))
  const targetsOf = phase => new Map(overlays.filter(overlay => overlay.phase === phase)
    .flatMap(overlay => overlayTargets(overlay, product, base).map(path => [path, overlay.id])))
  const configured = targetsOf('configure')
  for (const [path, id] of targetsOf('plugins')) {
    assert.ok(!configured.has(path), `${id} 与 ${configured.get(path)} 都修改 ${path}；plugins 与 configure 阶段的目标必须互不重叠`)
  }
  return { overlays, checks, reviews }
}

/* ----------------------------- 上游改动 ----------------------------- */

/** staging 路径 → 上游仓库与仓库内路径；已安装依赖返回 undefined。 */
function upstreamLocation(path, product) {
  if (/(^|\/)node_modules\//u.test(path)) return undefined
  const plugin = /^dsh-plugin-desktop\/product-plugins\/([^/]+)\/(.+)$/u.exec(path)
  if (plugin) {
    const declared = product.plugins.find(item => item.id === plugin[1])
    return declared?.artifact === undefined && declared ? { repo: declared.path, file: plugin[2], input: `plugin:${declared.id}` } : undefined
  }
  return { repo: 'desktop', file: path, input: 'desktop' }
}

function upstreamDiff(repo, from, to, files) {
  if (!from || !to || from === to) return ''
  const result = spawnSync('git', ['-C', resolve(root, repo), 'diff', '--stat', `${from}..${to}`, '--', ...files], { encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : `（无法比较 ${from.slice(0, 10)}..${to.slice(0, 10)}：${result.stderr.trim().split('\n')[0]}）`
}

/* ----------------------------- 输出 ----------------------------- */

const marks = {
  changed: '✔ 生效',
  unchanged: '○ 无变化——上游可能已修复，候选删除',
  fallback: '◌ 读取已装配副本，可能已加工，无法判定',
  failed: '✖ 失败——锚点或上游结构变了，需要修改',
  skipped: '– 未启用（条件不满足）',
  unchecked: '· 未体检（生成型步骤，需完整构建验证）',
}

function evidenceFor(review, id) {
  return review.evidence.filter(item => item.overlays.includes(id)).map(item => item.verified)
}

function printOverlay(overlay, { product, reviews, current }) {
  const review = reviews[overlay.module]
  const changed = pinChanges(overlay, review.baseline, current)
  const unpinned = overlay.upstream.filter(input => ['market-server', 'product'].includes(input))
  const status = changed.length ? `需复查：${changed.join(', ')} 已变化`
    : unpinned.length === overlay.upstream.length ? '无独立 pin' : 'pin 与基线一致'
  console.log(`\n${overlay.id}  [${overlay.phase} · ${overlay.kind}]  ${status}`)
  console.log(`  目标: ${overlayTargets(overlay, product).join(', ')}`)
  console.log(`  原因: ${overlay.why}`)
  console.log(`  删除: ${overlay.retireWhen}`)
  for (const text of evidenceFor(review, overlay.id)) console.log(`  验证: ${text}`)
  return changed
}

async function doctor({ product, overlays, fallbackName }) {
  const stageName = 'desktop-overlay-doctor'
  const stage = resolve(root, '.build', stageName)
  const report = resolve(root, '.build', `${stageName}.json`)
  // 每次从空目录开始，避免上一轮写入的已安装文件被当成未加工的输入。
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(resolve(root, '.build'), { recursive: true })
  console.log(`==> 在 .build/${stageName} 中复制上游并执行 prepare / assemble 覆盖`)
  const prepared = spawnSync(process.execPath, [resolve(import.meta.dirname, 'staging-prepare.mjs')], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PRODUCT_STAGE_NAME: stageName, PRODUCT_OVERLAY_AUDIT: report },
  })
  if (prepared.status !== 0) throw new Error('体检装配失败：先运行 yarn product:prepare 所需的插件产物获取')
  const results = JSON.parse(readFileSync(report, 'utf8'))
  const fallback = resolve(root, '.build', fallbackName)
  console.log(`==> installed / plugins / configure 覆盖：缺少的已安装文件从 .build/${fallbackName} 读取`)
  for (const phase of phases.filter(item => !['prepare', 'assemble'].includes(item))) {
    results.push(...await runOverlays(phase, {
      stage, product, overlays, audit: true, fallback, options: { packagingTarget: 'default' },
    }))
  }
  const byStatus = result => result.status === 'unchanged' && result.fromFallback ? 'fallback' : result.status
  for (const status of Object.keys(marks)) {
    const items = results.filter(result => byStatus(result) === status)
    if (!items.length) continue
    console.log(`\n${marks[status]}（${items.length}）`)
    if (status === 'changed') {
      console.log(`  ${items.map(item => item.id).join('、')}`)
      continue
    }
    for (const item of items) console.log(`  ${item.id.padEnd(36)} ${item.error ?? (item.files ?? []).join(', ')}`)
  }
  return results
}

/* ----------------------------- 命令行 ----------------------------- */

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = name => args.includes(name)
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const selected = args.find(arg => modules.includes(arg))
  const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
  const current = currentPins(product)
  const { overlays, checks, reviews } = await validateRegistry()
  const scoped = overlays.filter(overlay => !selected || overlay.module === selected)

  if (option('--file') !== undefined) {
    const query = option('--file').replaceAll('\\', '/')
    for (const phase of phases) {
      for (const overlay of scoped.filter(item => item.phase === phase)) {
        const hits = overlayTargets(overlay, product).filter(path => path.includes(query))
        if (hits.length) console.log(`${phase.padEnd(10)} ${overlay.id.padEnd(36)} ${hits.join(', ')}`)
      }
    }
  } else if (flag('--doctor')) {
    const results = await doctor({ product, overlays, fallbackName: option('--fallback') ?? productStage(root).split(/[\\/]/u).pop() })
    const changed = scoped.filter(overlay => pinChanges(overlay, reviews[overlay.module].baseline, current).length)
    if (changed.length) console.log('\n△ 固定输入已变化——以下被覆盖文件在基线与当前 pin 之间的上游改动：')
    for (const overlay of changed) {
      const baseline = reviews[overlay.module].baseline
      const groups = new Map()
      for (const path of overlayTargets(overlay, product)) {
        const location = upstreamLocation(path, product)
        if (!location || !overlay.upstream.includes(location.input)) continue
        groups.set(location.repo, { ...location, files: [...(groups.get(location.repo)?.files ?? []), location.file] })
      }
      for (const { repo, files, input } of groups.values()) {
        const id = input.slice('plugin:'.length)
        const [from, to] = input === 'desktop' ? [baseline.desktop, current.desktop] : [baseline.plugins?.[id]?.commit, current.plugins[id]?.commit]
        const diff = upstreamDiff(repo, from, to, files)
        console.log(`\n  ${overlay.id}（${repo}：${files.join(', ')}）`)
        console.log(diff
          ? diff.split('\n').map(line => `    ${line}`).join('\n')
          : '    被覆盖文件在两次 pin 之间没有改动；仍需确认覆盖的前提（如插件行为）未变')
      }
      if (overlay.upstream.includes('dsh') && pinChanges(overlay, baseline, current).includes('dsh')) {
        console.log(`\n  ${overlay.id}：DSH ${baseline.dsh?.version ?? '无基线'} → ${current.dsh.version}，已安装文件以上面的执行结果为准`)
      }
    }
    console.log('\n复查完成后：删掉 ○ 的覆盖、修改 ✖ 的覆盖，运行 yarn test:build，再把对应模块 review.json 的 baseline 更新为当前 pin 并补充验证证据。')
    if (results.some(result => result.status === 'failed')) process.exitCode = 1
  } else {
    let changed = 0
    for (const phase of phases) {
      const items = scoped.filter(overlay => overlay.phase === phase)
      if (items.length) console.log(`\n========== ${phase} ==========`)
      for (const overlay of items) if (printOverlay(overlay, { product, reviews, current }).length) changed++
    }
    console.log('\n========== 检查脚本（不修改 staging） ==========')
    for (const check of checks.filter(item => !selected || item.module === selected)) {
      console.log(`  ${check.module}/${check.file}  ${check.runBy}`)
    }
    console.log(`\n${scoped.length} 条覆盖；${changed} 条的固定输入相对基线有变化。用 --doctor 在临时 staging 中实际执行并判定。`)
    if (flag('--check') && changed) process.exitCode = 1
  }
}
