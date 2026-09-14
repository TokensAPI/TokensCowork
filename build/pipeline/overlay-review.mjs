// Read-only inventory and upgrade drift report. Never applies or deletes patches.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const modules = ['branding', 'market', 'runtime', 'updates', 'platform']
const root = resolve(import.meta.dirname, '../..')
export function loadCatalog(base = root) {
  const records = modules.map(module => {
    const record = JSON.parse(readFileSync(resolve(base, 'build/modules', module, 'review.json'), 'utf8'))
    assert.equal(record.schemaVersion, 1)
    assert.ok(record.entries.every(entry => entry.module === module), `Wrong module in ${module}/review.json`)
    return record
  })
  return {
    schemaVersion: 1,
    entries: records.flatMap(record => record.entries.map(entry => ({ ...entry, baseline: record.baseline }))),
    diagnostics: records.flatMap(record => record.diagnostics ?? []),
  }
}

export function currentInputs(product) {
  const plugin = value => value ? {
    commit: value.commit, version: value.version,
    artifact: value.artifact?.sha256 ?? null, enabled: value.enabledByDefault,
  } : null
  return {
    desktop: product.desktop.commit,
    dsh: { commit: product.desktop.deepseekHarnessCommit, version: product.desktop.runtimeVersion },
    plugins: product.plugins.map(value => ({ id: value.id, ...plugin(value) })),
    ui: plugin(product.plugins.find(value => value.id === 'dsh-tokensapi-ui')),
    updates: plugin(product.plugins.find(value => value.id === 'tokens-version-updates')),
  }
}

export function reviewEntries(catalog, product) {
  const current = currentInputs(product)
  return catalog.entries.map(entry => ({
    ...entry,
    changed: entry.inputs.filter(input => JSON.stringify(entry.baseline[input]) !== JSON.stringify(current[input])),
  }))
}

export function validateCatalog(catalog, base = root) {
  assert.equal(catalog.schemaVersion, 1)
  const ids = new Set()
  const owned = new Set()
  for (const entry of catalog.entries) {
    assert.ok(!ids.has(entry.id), `duplicate overlay: ${entry.id}`)
    ids.add(entry.id)
    assert.ok(modules.includes(entry.module), `unknown module: ${entry.module}`)
    assert.ok(['customization', 'compatibility', 'workaround'].includes(entry.kind))
    assert.ok(['active', 'inactive', 'upstream'].includes(entry.state))
    for (const key of ['reason', 'retireWhen', 'verification']) assert.ok(entry[key]?.trim(), `${entry.id}: missing ${key}`)
    assert.ok(entry.files.length && entry.targets.length, `${entry.id}: missing implementation or targets`)
    assert.ok(entry.state === 'inactive' || entry.appliedBy.length, `${entry.id}: missing caller`)
    for (const input of entry.inputs) assert.ok(Object.hasOwn(entry.baseline, input), `${entry.id}: unknown input ${input}`)
    for (const file of [...entry.files, ...entry.appliedBy]) {
      const path = resolve(base, file)
      assert.ok(!relative(base, path).startsWith('..') && existsSync(path), `${entry.id}: missing/unsafe file ${file}`)
    }
    entry.files.forEach(file => owned.add(file))
  }
  // Diagnostics are explicit opt-in commands, not automatically applied patches.
  for (const file of catalog.diagnostics) {
    assert.ok(/^build\/modules\/(branding|market|runtime|updates|platform)\/[a-z-]+\.mjs$/.test(file), `Unsafe diagnostic: ${file}`)
    assert.ok(existsSync(resolve(base, file)), `Missing diagnostic: ${file}`)
    owned.add(file)
  }
  for (const module of modules) {
    for (const item of readdirSync(resolve(base, 'build/modules', module), { withFileTypes: true })) {
      assert.ok(!item.isDirectory() || item.name === 'assets', `Only assets may nest below ${module}`)
      if (!item.name.endsWith('.mjs') || item.name.endsWith('.test.mjs')) continue
      const path = `build/modules/${module}/${item.name}`
      assert.ok(owned.has(path), `Unregistered module implementation: ${path}`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const selected = args.find(arg => modules.includes(arg))
  assert.ok(args.every(arg => arg === selected || arg === '--check'), 'Usage: overlay-review.mjs [module] [--check]')
  const catalog = loadCatalog()
  const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
  validateCatalog(catalog)
  const entries = reviewEntries(catalog, product).filter(entry => !selected || entry.module === selected)
  for (const entry of entries) {
    const status = entry.changed.length ? `REVIEW REQUIRED: ${entry.changed.join(', ')}`
      : entry.inputs.length ? 'pin 基线一致；行为仍需验证' : '无独立 pin；人工复查目标源码'
    console.log(`\n${entry.id} [${entry.kind}/${entry.state}] ${status}`)
    console.log(`  实现: ${entry.files.join(', ')}\n  入口: ${entry.appliedBy.join(', ') || '未接入'}`)
    console.log(`  目标: ${entry.targets.join('; ')}\n  原因: ${entry.reason}`)
    console.log(`  验证: ${entry.verification}\n  退出: ${entry.retireWhen}`)
  }
  const changed = entries.filter(entry => entry.changed.length)
  console.log(`\n${entries.length} 条记录；${changed.length} 条 pin 变化待复查。不会自动判断上游已修复，也不会修改基线。`)
  if (args.includes('--check') && changed.length) process.exitCode = 1
}
