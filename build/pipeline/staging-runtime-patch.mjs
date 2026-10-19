// Apply installed-runtime overlays after Yarn install; safe to repeat on dev caches.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runOverlays } from './overlay-engine.mjs'
import { productStage } from './paths.mjs'
import { verifyCompactionRuntime } from '../modules/runtime/staging-compaction-smoke.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const stage = productStage(root)
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))

// 每条 installed 覆盖都要求依赖已安装；缺包时报出具体覆盖 id 并失败。
await runOverlays('installed', { stage, product })
// DSH 0.2 replaces agent-presets with preset-registry. The former filesystem
// discovery seam no longer exists; Desktop Loader/profile/closure checks own
// resolution of the declarative preset tree.
await verifyCompactionRuntime(resolve(stage, 'dsh-plugin-desktop'))
console.log('verify-runtime: runtime compatibility checks passed')
