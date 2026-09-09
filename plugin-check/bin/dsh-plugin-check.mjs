#!/usr/bin/env node
/* ============================================================
 * dsh-plugin-check:插件合格性体检 CLI
 * ============================================================
 * 用法:
 *   npx @tokensapi/dsh-plugin-check [插件目录] [选项]
 *
 * 选项:
 *   --runtime <version>  目标 DSH 运行时版本(启用 engine/peer 交集判定)
 *   --skip-smoke         只跑清单体检(离线、秒级)
 *   --keep-workspace     保留冒烟临时工作区供排查
 *   --strict             warning 也计入失败
 *   --json               机器可读输出(市场门禁用)
 *
 * 退出码:0 = 合格;1 = 存在 error(--strict 时含 warning)。
 * ============================================================ */
import { resolve } from 'node:path'
import { checkManifest } from '../lib/manifest-check.mjs'
import { checkSmoke } from '../lib/smoke-check.mjs'

const args = process.argv.slice(2)
const options = { dir: process.cwd(), runtime: undefined, skipSmoke: false, keepWorkspace: false, strict: false, json: false }
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--runtime') { options.runtime = args[++index]; continue }
  if (arg === '--skip-smoke') { options.skipSmoke = true; continue }
  if (arg === '--keep-workspace') { options.keepWorkspace = true; continue }
  if (arg === '--strict') { options.strict = true; continue }
  if (arg === '--json') { options.json = true; continue }
  if (arg === '--help' || arg === '-h') {
    process.stdout.write('用法: dsh-plugin-check [插件目录] [--runtime <version>] [--skip-smoke] [--keep-workspace] [--strict] [--json]\n')
    process.exit(0)
  }
  if (arg.startsWith('--')) {
    process.stderr.write(`未知选项: ${arg}\n`)
    process.exit(2)
  }
  options.dir = resolve(arg)
}

const findings = []
const phases = []

const manifestResult = checkManifest(options.dir, { runtime: options.runtime })
findings.push(...manifestResult.findings)
phases.push({ phase: 'manifest', findings: manifestResult.findings })

let smokeSkipped = true
if (!options.skipSmoke
  && manifestResult.manifest !== undefined
  && manifestResult.rows !== undefined
  && !manifestResult.findings.some(finding => finding.level === 'error')) {
  smokeSkipped = false
  const smokeResult = checkSmoke(options.dir, manifestResult.manifest, manifestResult.rows, {
    keepWorkspace: options.keepWorkspace,
  })
  findings.push(...smokeResult.findings)
  phases.push({ phase: 'smoke', findings: smokeResult.findings, workspace: smokeResult.workspace })
} else if (!options.skipSmoke) {
  phases.push({ phase: 'smoke', skipped: '清单体检存在 error,冒烟不再执行' })
}

const errors = findings.filter(finding => finding.level === 'error')
const warnings = findings.filter(finding => finding.level === 'warning')
const infos = findings.filter(finding => finding.level === 'info')
const failed = errors.length > 0 || (options.strict && warnings.length > 0)

if (options.json) {
  process.stdout.write(`${JSON.stringify({
    ok: !failed,
    plugin: manifestResult.manifest?.name,
    version: manifestResult.manifest?.version,
    runtime: options.runtime ?? null,
    errors,
    warnings,
    phases,
  }, undefined, 2)}\n`)
  process.exit(failed ? 1 : 0)
}

const title = manifestResult.manifest?.name !== undefined
  ? `${manifestResult.manifest.name}@${manifestResult.manifest.version ?? '?'}`
  : options.dir
process.stdout.write(`\ndsh-plugin-check · ${title}\n`)
if (options.runtime !== undefined) process.stdout.write(`目标运行时: ${options.runtime}\n`)
process.stdout.write('\n')
for (const finding of errors) process.stdout.write(`  ❌ [${finding.rule}] ${finding.message}\n`)
for (const finding of warnings) process.stdout.write(`  ⚠️  [${finding.rule}] ${finding.message}\n`)
for (const finding of infos) process.stdout.write(`  ✅ ${finding.message}
`)
if (findings.length === 0) process.stdout.write('  全部规则通过\n')
process.stdout.write('\n')
if (smokeSkipped && !options.skipSmoke && errors.length > 0) {
  process.stdout.write('清单存在 error,隔离冒烟未执行;修复后重跑。\n')
} else if (options.skipSmoke) {
  process.stdout.write('已按 --skip-smoke 跳过隔离冒烟。\n')
}
process.stdout.write(failed
  ? `结论: 不合格(${errors.length} error / ${warnings.length} warning)\n`
  : `结论: 合格(0 error / ${warnings.length} warning)\n`)
process.exit(failed ? 1 : 0)
