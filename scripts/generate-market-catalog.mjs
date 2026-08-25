/* ============================================================
 * 插件市场目录源生成
 * ============================================================
 * 从 product.json 抽取本产品自有插件，生成 DSH Community Market
 * 标准目录源（standard source）所需的两个静态文件：
 *
 *   market/source.json   目录源 manifest（用户在市场"源"里登记的 URL）
 *   market/v1/plugins    目录端点响应（市场 Host 拉取的插件列表）
 *
 * 输出遵循 desktop/dsh-community-market/docs/schemas/ 下的
 * catalog-source 1.0.0 与 catalog-provider-page 1.0.0 契约。
 * 部署源 origin 在 market/source.config.json 中配置；manifest 与
 * 端点必须同源，这是市场 Host 的强制校验。
 * ============================================================ */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* ------------------------------------------------------------
 * 契约约束校验
 * ------------------------------------------------------------
 * 市场 Host 对源数据 fail-closed：任何字段越界都会拒绝整个源。
 * 生成侧提前把关，违约直接失败而不是产出坏文件。
 * ------------------------------------------------------------ */

const PLAIN_TEXT = /^[^\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]*$/u

/**
 * 校验一段用户可见文本符合契约的 plainText 约束。
 * @param {string} value - 待校验文本。
 * @param {number} maxLength - 契约上限。
 * @param {string} label - 出错时定位用的字段名。
 * @returns {string} 原样返回通过校验的文本。
 * @throws 文本为空、超长或含受控字符时抛出。
 */
function assertPlainText(value, maxLength, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
    || !PLAIN_TEXT.test(value)) {
    throw new Error(`generate-market-catalog: ${label} 为空、超长或包含契约禁止的字符`)
  }
  return value
}

/**
 * 由产品清单构造目录端点的 provider page。
 * @param {object} product - 解析后的 product.json 内容。
 * @returns {{ schemaVersion: string, items: object[], page: object }}
 *   符合 catalog-provider-page 1.0.0 的响应对象。
 * @throws 插件缺少展示字段或字段违反契约约束时抛出。
 */
export function buildCatalogPage(product) {
  const items = (product.plugins ?? []).map(plugin => {
    const repository = String(plugin.repository ?? '').replace(/\.git$/u, '')
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/u.test(repository)) {
      throw new Error(`generate-market-catalog: ${plugin.id} 的 repository 不是规范的 GitHub HTTPS 地址`)
    }
    return {
      id: assertPlainText(plugin.id, 160, `${plugin.id}.id`),
      name: assertPlainText(plugin.package, 160, `${plugin.id}.package`),
      displayName: assertPlainText(plugin.displayName, 120, `${plugin.id}.displayName`),
      summary: assertPlainText(plugin.description, 1000, `${plugin.id}.description`),
      homepage: repository,
      latestVersion: assertPlainText(plugin.version, 64, `${plugin.id}.version`),
      repository: { url: repository },
      publisher: { name: 'TokensAPI', url: 'https://github.com/TokensAPI' },
    }
  })
  return { schemaVersion: '1.0.0', items, page: {} }
}

/**
 * 构造目录源 manifest。
 * @param {string} origin - 部署源 origin（https、无端口、无尾部斜杠）。
 * @returns {object} 符合 catalog-source 1.0.0 的 manifest 对象。
 * @throws origin 不符合标准源同源契约时抛出。
 */
export function buildSourceManifest(origin) {
  if (!/^https:\/\/[a-z0-9][a-z0-9.-]*$/u.test(origin)) {
    throw new Error('generate-market-catalog: origin 必须是 https 且不带端口、路径和尾部斜杠')
  }
  return {
    manifestVersion: '1.0.0',
    providerId: 'com.tokensapi.plugins',
    name: 'TokensAPI 插件源',
    description: 'TokensHarness 产品自有插件的官方目录源，数据来自 product.json 插件登记。',
    homepage: 'https://github.com/TokensAPI/tokens_TokensHarness_code',
    attribution: { name: 'TokensAPI', url: 'https://github.com/TokensAPI' },
    transport: { kind: 'https-json', endpoint: `${origin}/v1/plugins`, method: 'GET' },
    query: { supported: [], defaultLimit: 50, maxLimit: 50, sorts: [] },
  }
}

/* ------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------ */

if (process.argv[1] === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..')
  const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
  const config = JSON.parse(readFileSync(resolve(root, 'market', 'source.config.json'), 'utf8'))
  const page = buildCatalogPage(product)
  const manifest = buildSourceManifest(config.origin)
  mkdirSync(resolve(root, 'market', 'v1'), { recursive: true })
  writeFileSync(resolve(root, 'market', 'source.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(resolve(root, 'market', 'v1', 'plugins'), `${JSON.stringify(page, undefined, 2)}\n`)
  process.stdout.write(`generate-market-catalog: ${page.items.length} plugin(s) -> market/source.json, market/v1/plugins\n`)
}
