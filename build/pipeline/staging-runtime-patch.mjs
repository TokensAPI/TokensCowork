// Verify Desktop's preset patch; apply product runtime compatibility fixes once.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAsarPresetDiscovery } from '../modules/runtime/preset-discovery-verify.mjs'
import { productStage } from './paths.mjs'
import { alignConnectionRpcScope } from '../modules/runtime/runtime-version-overlay.mjs'
import { alignCompactionSummary } from '../modules/runtime/compaction-overlay.mjs'
import { verifyCompactionRuntime } from '../modules/runtime/staging-compaction-smoke.mjs'


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = productStage(resolve(import.meta.dirname, '..', '..'))
  let verified = 0
  let compactionPatched = 0
  for (const base of [resolve(stage, 'dsh-plugin-desktop'), stage]) {
    const compactionPath = resolve(base, 'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')
    if (existsSync(compactionPath)) {
      const source = readFileSync(compactionPath, 'utf8')
      const patched = alignCompactionSummary(source)
      if (patched !== source) writeFileSync(compactionPath, patched)
      compactionPatched++
    }
    const connectionPath = resolve(base, 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')
    if (existsSync(connectionPath)) {
      const source = readFileSync(connectionPath, 'utf8')
      const patched = alignConnectionRpcScope(source)
      if (patched !== source) writeFileSync(connectionPath, patched)
    }
    const path = resolve(base, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js')
    if (!existsSync(path)) continue
    verifyAsarPresetDiscovery(readFileSync(path, 'utf8'))
    verified++
  }
  assert.ok(verified > 0, 'agent-presets is not installed; run yarn install first')
  assert.ok(compactionPatched > 0, 'compaction-basic is not installed; run yarn install first')
  await verifyCompactionRuntime(resolve(stage, 'dsh-plugin-desktop'))
  console.log(`verify-runtime: ${verified} upstream asar-aware preset resolver(s) passed behavior checks`)
}
