/* ====================================================================
 * 产品配置（打包前）
 * 在依赖安装完成的 staging 上执行 configure 阶段覆盖：打包身份、安装器
 * 保护、macOS 单架构发布、产品更新来源、品牌文案、Logo 与图标。
 * 覆盖明细见各模块 overlays.mjs；本文件只解析参数并调用执行器。
 * ==================================================================== */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runOverlays } from './overlay-engine.mjs'
import { productStage } from './paths.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const packagingTarget = process.argv[2] ?? 'default'
if (!['default', 'windows', 'mac-arm64', 'mac-x64'].includes(packagingTarget)) {
  throw new Error('configure-product: expected default, windows, mac-arm64 or mac-x64 packaging target')
}

await runOverlays('configure', { stage: productStage(root), product, options: { packagingTarget } })
process.stdout.write(`configure-product: ${product.product.name} ${product.product.version} (${product.product.appId})\n`)
