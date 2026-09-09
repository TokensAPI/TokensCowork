/* ============================================================
 * 阶段②:隔离启动冒烟(联网,分钟级)
 * ============================================================
 * 在临时工作区里按插件自己声明的 peer 范围装出一套真实运行时,
 * 然后在子进程里逐行做真实网关会做的事:import 补丁行入口、
 * new Context()、ctx.plugin() 应用。这里能过,插件就不会以
 * "装上即崩"的方式杀死用户的 Cowork:
 *  - 装不上(依赖解析失败)在 install 步暴露;
 *  - import 期崩溃(顶层异常/缺模块/ESM 形状)在 import 步暴露;
 *  - 应用期崩溃(apply 抛出/插件形状不合法)在 plugin 步暴露;
 *  - 声明了 inject 而服务未注入属正常停车,不算失败。
 * 全程 --ignore-scripts,被测代码没有机会在检查器进程里执行
 * 安装钩子;插件代码只在一次性子进程里运行,超时即杀。
 * ============================================================ */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runNpm } from './npm.mjs'

const RUNNER_TIMEOUT_MS = 90_000
const INSTALL_TIMEOUT_MS = 300_000

/** 子进程执行的行级冒烟脚本;结果写文件,避开插件对 stdout 的污染。 */
const RUNNER_SOURCE = `
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
const [workspace, resultPath, rowsJson] = process.argv.slice(2)
const rows = JSON.parse(rowsJson)
const results = []
let current = null
process.on('uncaughtException', (cause) => finish(cause))
process.on('unhandledRejection', (cause) => finish(cause))
function finish(cause) {
  if (current !== null) {
    results.push({ ...current, status: 'failed', stage: current.stage,
      error: cause instanceof Error ? cause.message : String(cause) })
    current = null
  }
  writeFileSync(resultPath, JSON.stringify(results))
  process.exit(0)
}
const { createRequire } = await import('node:module')
const workspaceRequire = createRequire(pathToFileURL(workspace + '/x.js'))
let Context
try {
  const cordis = await import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/cordis')))
  Context = cordis.Context
} catch (cause) {
  writeFileSync(resultPath, JSON.stringify([{ name: '@deepseek-ai/cordis', stage: 'import',
    status: 'failed', error: '无法载入 cordis 运行时: ' + (cause instanceof Error ? cause.message : String(cause)) }]))
  process.exit(0)
}
for (const row of rows) {
  current = { name: row.name, stage: 'resolve' }
  try {
    const entryPath = workspaceRequire.resolve(row.name)
    current.stage = 'import'
    const mod = await import(pathToFileURL(entryPath))
    const plugin = mod.default ?? mod
    current.stage = 'apply'
    const ctx = new Context()
    if (row.dynamicConfig) ctx.plugin(plugin)
    else if (row.config === undefined) ctx.plugin(plugin)
    else ctx.plugin(plugin, row.config)
    await new Promise((r) => setTimeout(r, 750))
    results.push({ name: row.name, status: 'ok',
      note: row.dynamicConfig ? '配置含动态表达式,以空配置应用' : undefined })
    current = null
  } catch (cause) {
    results.push({ name: row.name, status: 'failed', stage: current.stage,
      error: cause instanceof Error ? cause.message : String(cause) })
    current = null
  }
}
writeFileSync(resultPath, JSON.stringify(results))
process.exit(0)
`


/**
 * 对插件目录执行隔离冒烟。
 * @param {string} pluginDir - 插件根目录。
 * @param {object} manifest - 已解析的 package.json。
 * @param {Array<{name: string, config?: unknown, disabled?: boolean, dynamicConfig: boolean}>} rows - 补丁行。
 * @param {{ keepWorkspace?: boolean }} [options]
 * @returns {{ findings: Array<{level: 'error'|'warning', rule: string, message: string}>, workspace?: string }}
 */
export function checkSmoke(pluginDir, manifest, rows, options = {}) {
  const findings = []
  const error = (rule, message) => findings.push({ level: 'error', rule, message })
  const warning = (rule, message) => findings.push({ level: 'warning', rule, message })

  const workspace = mkdtempSync(join(tmpdir(), 'dsh-plugin-check-'))
  const cleanup = () => {
    if (options.keepWorkspace) return
    try { rmSync(workspace, { recursive: true, force: true }) } catch { /* 临时目录残留不影响判定 */ }
  }

  try {
    // S1 打包:--ignore-scripts 跳过 prepack 等脚本,只验证发布内容本身。
    const pack = runNpm(['pack', resolve(pluginDir), '--ignore-scripts', '--pack-destination', workspace], workspace, INSTALL_TIMEOUT_MS)
    if (pack.status !== 0) {
      error('S1-pack', `npm pack 失败: ${(pack.stderr || pack.stdout || '').trim().split('\n').slice(-3).join(' ')}`)
      return { findings, workspace: options.keepWorkspace ? workspace : undefined }
    }
    const tarball = readdirSync(workspace).find(name => name.endsWith('.tgz'))
    if (tarball === undefined) {
      error('S1-pack', 'npm pack 未产出 tgz')
      return { findings, workspace: options.keepWorkspace ? workspace : undefined }
    }

    // S2 安装:插件走 tgz(等价用户侧的受控安装),运行时按插件自己
    // 声明的 peer 范围解析;cordis 是冒烟宿主的最低要求,未声明则补上。
    const dependencies = { [manifest.name]: `file:./${tarball}` }
    const peers = manifest.peerDependencies ?? {}
    for (const [name, range] of Object.entries(peers)) dependencies[name] = range
    if (dependencies['@deepseek-ai/cordis'] === undefined) {
      dependencies['@deepseek-ai/cordis'] = '*'
      warning('S2-install', 'peerDependencies 未声明 @deepseek-ai/cordis,冒烟以最新版补齐;建议显式声明')
    }
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-check-workspace',
      private: true,
      dependencies,
    }, undefined, 2))
    const install = runNpm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      workspace,
      INSTALL_TIMEOUT_MS,
    )
    if (install.status !== 0) {
      error('S2-install', `依赖装不出来(用户侧受控安装会同样失败): ${(install.stderr || '').trim().split('\n').slice(-4).join(' ')}`)
      return { findings, workspace: options.keepWorkspace ? workspace : undefined }
    }

    // S3+S4 行级冒烟:解析/import/apply 三段判定在子进程完成。
    const activeRows = rows.filter(row => !row.disabled)
    if (activeRows.length === 0) {
      warning('S3-rows', '补丁没有启用状态的行,冒烟无事可做')
      return { findings, workspace: options.keepWorkspace ? workspace : undefined }
    }
    const runnerPath = join(workspace, '__runner.mjs')
    const resultPath = join(workspace, '__result.json')
    writeFileSync(runnerPath, RUNNER_SOURCE)
    const run = spawnSync(process.execPath, [
      runnerPath,
      workspace,
      resultPath,
      JSON.stringify(activeRows.map(row => ({ name: row.name, config: row.config, dynamicConfig: row.dynamicConfig }))),
    ], { cwd: workspace, encoding: 'utf8', timeout: RUNNER_TIMEOUT_MS })
    if (!existsSync(resultPath)) {
      const reason = run.signal === 'SIGTERM'
        ? `超时(${RUNNER_TIMEOUT_MS / 1000}s):入口疑似在顶层做阻塞等待`
        : (run.stderr || '子进程未产出结果').trim().split('\n').slice(-3).join(' ')
      error('S4-apply', `冒烟子进程异常: ${reason}`)
      return { findings, workspace: options.keepWorkspace ? workspace : undefined }
    }
    const results = JSON.parse(readFileSync(resultPath, 'utf8'))
    const passed = results.filter(result => result.status === 'ok').length
    findings.push({ level: 'info', rule: 'S4-apply', message: `隔离冒烟: ${passed}/${results.length} 行通过(解析→import→应用)` })
    for (const result of results) {
      if (result.status === 'ok') {
        if (result.note !== undefined) warning('S4-apply', `${result.name}: ${result.note}`)
        continue
      }
      const stageLabel = { resolve: '入口解析', import: 'import 载入', apply: '插件应用' }[result.stage] ?? result.stage
      error('S4-apply', `${result.name} 在 ${stageLabel} 阶段失败: ${result.error}(装入用户 Cowork 会在启动链同点崩溃)`)
    }
    return { findings, workspace: options.keepWorkspace ? workspace : undefined }
  } finally {
    cleanup()
  }
}
