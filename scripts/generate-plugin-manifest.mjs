/**
 * 内置插件清单生成：从 product.json 抽取默认启用插件的用户可见信息，
 * 输出下载页渲染"内置插件"所需的 JSON。发布工作流将其作为
 * TokensCowork-<version>-plugins.json 资产随 Release 发布。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 由 product.json 清单构造插件展示清单。
 * @param {object} manifest - 解析后的 product.json 内容。
 * @returns {{ schemaVersion: number, product: string, version: string, plugins: object[] }}
 *   含 schemaVersion 的展示清单；plugins 仅收默认启用项。
 * @throws 当默认启用的插件缺少 displayName 或 description 时抛出，
 *   强制补齐用户可见文案后才能发布。
 */
export function buildPluginManifest(manifest) {
  const plugins = (manifest.plugins ?? [])
    .filter(plugin => plugin.enabledByDefault === true)
    .map(plugin => {
      if (typeof plugin.displayName !== 'string' || plugin.displayName.length === 0
        || typeof plugin.description !== 'string' || plugin.description.length === 0) {
        throw new Error(`generate-plugin-manifest: ${plugin.id} 缺少 displayName 或 description`)
      }
      return {
        id: plugin.id,
        name: plugin.displayName,
        description: plugin.description,
        package: plugin.package,
        version: plugin.version,
        homepage: plugin.repository.replace(/\.git$/u, ''),
      }
    })
  return {
    schemaVersion: 1,
    product: manifest.product.name,
    version: manifest.product.version,
    plugins,
  }
}

/** Release distribution comes from the pinned product, never the version suffix. */
export function buildReleaseNotes(manifest, notes) {
  const distribution = buildPluginManifest(manifest).plugins.length === 0 ? 'clean' : 'bundled'
  const body = notes.replace(/<!--\s*tokenscowork:distribution=[^>]*-->/gu, '').trimEnd()
  return `${body}\n\n<!-- tokenscowork:distribution=${distribution} -->\n`
}

if (process.argv[1] === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
  if (process.argv.length === 2) {
    process.stdout.write(`${JSON.stringify(buildPluginManifest(manifest), undefined, 2)}\n`)
  } else if (process.argv.length === 4 && process.argv[2] === '--release-notes') {
    process.stdout.write(buildReleaseNotes(manifest, readFileSync(process.argv[3], 'utf8')))
  } else throw new Error('expected no arguments or --release-notes <path>')
}
