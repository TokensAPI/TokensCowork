/* ============================================================
 * 插件市场数据一致性校验
 * ============================================================
 * 市场目录的唯一事实来源是 market/roster.json。这里检查：
 *
 *   1. source.json 必须与 source.config.json 一致，roster.json 必须能
 *      生成合法的市场目录。静态 market/v1/plugins 由部署流程
 *      现场生成，不纳入 Git。
 *   2. 名册里 npm: false 的内置插件版本是手写的——_worker.js 只对
 *      npm: true 的条目实时问 registry。同一个 id 若作为默认插件登记在
 *      product.json 里，两处版本必须相同。曾经 roster 停在 connect
 *      2.4.4 而 product.json 已到 2.5.0，因为升插件和改市场是两条
 *      互不相干的工作流。
 *
 * 入口：pnpm/yarn market:check，以及 build/verify/repo-layout-verify.mjs 在发版
 * 校验时一并调用。
 * ============================================================ */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildCatalogPage, buildSourceManifest } from '../../scripts/generate-market-catalog.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const fail = message => { throw new Error(`verify-market: ${message}`) }
const readJson = (...segments) => JSON.parse(readFileSync(resolve(root, ...segments), 'utf8'))

const roster = readJson('market', 'roster.json')
const config = readJson('market', 'source.config.json')
const manifest = readJson('product.json')

/* ------------------------ 1. 源数据能否正确生成 ------------------------ */

const catalog = buildCatalogPage(roster)
const expectedSource = `${JSON.stringify(buildSourceManifest(config.origin), undefined, 2)}\n`
// Windows CI 的 git autocrlf 会把检出内容转成 CRLF，比较前归一化。
if (readFileSync(resolve(root, 'market', 'source.json'), 'utf8').replaceAll('\r\n', '\n') !== expectedSource) {
  fail('market/source.json 与 market/source.config.json 不一致；运行 node scripts/generate-market-catalog.mjs 重新生成')
}

/* ---------------------- 2. 内置插件版本是否两处一致 ---------------------- */

const productVersions = new Map(
  manifest.plugins
    .filter(plugin => plugin.enabledByDefault === true)
    .map(plugin => [plugin.id, plugin.version]),
)
for (const item of roster.items) {
  const bundled = productVersions.get(item.id)
  // 只在两处都登记时比对：仅在名册里的条目（纯市场分发、或仅供浏览）
  // 本来就没有 product.json 对应项，不构成漂移。
  if (bundled !== undefined && bundled !== item.version) {
    fail(`${item.id} 版本漂移：market/roster.json 写 ${item.version}，product.json 写 ${bundled}`)
  }
}

process.stdout.write(
  `verify-market: ${catalog.items.length} roster item(s), 目录可生成，${productVersions.size} 个内置插件版本一致\n`,
)
