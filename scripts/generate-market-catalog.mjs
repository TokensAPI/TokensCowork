// Deployment assets only. Plugin records live in D1, not a static roster.
import { readFileSync, writeFileSync } from 'node:fs'
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

function optionalInstallSource(value, label) {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.kind !== 'github' || !/^[0-9a-f]{40}$/u.test(value.commit ?? '')
    || Object.keys(value).some(key => key !== 'kind' && key !== 'commit')) {
    throw new Error(`generate-market-catalog: ${label} 不是固定 Git commit 的 GitHub 安装源`)
  }
  return { installSource: { kind: 'github', commit: value.commit } }
}

/**
 * 由插件名册构造目录端点的 provider page。
 * @param {object} roster - 数据库目录或一次性迁移校验数据。
 * @returns {{ schemaVersion: string, items: object[], page: object }}
 *   符合 catalog-provider-page 1.0.0 的响应对象。
 * @throws 名册形状不对、条目缺少展示字段或字段违反契约约束时抛出。
 */
export function buildCatalogPage(roster) {
  if (!Array.isArray(roster.items)
    || typeof roster.publisher !== 'object' || roster.publisher === null) {
    throw new Error('generate-market-catalog: 目录缺少 items 数组或 publisher')
  }
  const items = roster.items.map(item => {
    const repository = String(item.repository ?? '').replace(/\.git$/u, '')
    if (!(item.npm === true && !repository) && !/^https:\/\/github\.com\/[^/]+\/[^/]+$/u.test(repository)) {
      throw new Error(`generate-market-catalog: ${item.id} 的 repository 不是规范的 GitHub HTTPS 地址`)
    }
    return {
      id: assertPlainText(item.id, 160, `${item.id}.id`),
      name: assertPlainText(item.package, 160, `${item.id}.package`),
      displayName: assertPlainText(item.displayName, 120, `${item.id}.displayName`),
      summary: assertPlainText(item.summary, 1000, `${item.id}.summary`),
      homepage: repository || 'https://www.npmjs.com/package/' + item.package,
      latestVersion: assertPlainText(item.version, 64, `${item.id}.version`),
      ...(repository ? { repository: { url: repository } } : {}),
      ...optionalInstallSource(item.installSource, `${item.id}.installSource`),
      // npm: true 的条目已发布到 npm 官方 registry：目录条目带上 package
      // 字段后，市场 Host 会将其识别为可托管安装的候选，并在预览与执行
      // 时对 npm 实时核验身份、仓库与完整性。这里的 latestVersion 是名册
      // 里的兜底值，线上由 worker 换成 dist-tags.latest。
      ...(item.npm === true
        ? { package: { registry: 'npm', name: item.package } }
        : {}),
      publisher: roster.publisher,
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
    description: 'TokensCowork 官方插件目录，由市场数据库动态提供。',
    homepage: 'https://github.com/TokensAPI/TokensCowork',
    attribution: { name: 'TokensAPI', url: 'https://github.com/TokensAPI' },
    transport: { kind: 'https-json', endpoint: `${origin}/v1/plugins`, method: 'GET' },
    query: { supported: [], defaultLimit: 50, maxLimit: 50, sorts: [] },
  }
}

/* ------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------ */

export function buildProductComponents(product) {
  return { productVersion: product.product.version, items: product.plugins.filter(p=>p.enabledByDefault && p.patch).map(p=>({ id:p.id,package:p.package,displayName:p.displayName,version:p.version,commit:p.commit,category:'builtin' })) }
}
if (process.argv[1] === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..')
  const config = JSON.parse(readFileSync(resolve(root, 'market', 'server', 'source.config.json'), 'utf8'))
  const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
  writeFileSync(resolve(root,'market','server','source.json'),JSON.stringify(buildSourceManifest(config.origin),null,2)+'\n')
  writeFileSync(resolve(root,'market','server','product-components.json'),JSON.stringify(buildProductComponents(product),null,2)+'\n')
  process.stdout.write('Generated market manifest and product component identities; no plugin snapshot.\n')
}
