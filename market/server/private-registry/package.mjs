import { npmPackageMetadata, npmReference } from '../integrations/npm-registry.js'
import { invalid, packageOK, versionOK } from '../services/catalog-service.js'
import { createRegistryClient } from './client.mjs'
import { registryConfig } from './config.mjs'

function reference(input, requested, config) {
  if (typeof input !== 'string' || input.length > 512) throw invalid('请输入自建 Registry 包名或详情页链接')
  const trimmed = input.trim()
  if (!/^https?:/iu.test(trimmed)) return npmReference(trimmed, requested)
  let url, path
  try {
    url = new URL(trimmed)
    path = decodeURIComponent(url.pathname)
  } catch { throw invalid('自建 Registry 链接无效') }
  const detail = new URL('-/web/detail/', config.url)
  if (url.protocol !== 'https:' || url.origin !== detail.origin || url.username || url.password
    || !path.startsWith(detail.pathname) || path === detail.pathname)
    throw invalid('仅支持当前 TokensCowork 自建 Registry 的包详情页链接')
  const name = path.slice(detail.pathname.length).replace(/\/$/u, '')
  if (!packageOK(name) || (requested !== 'latest' && !versionOK(requested)))
    throw invalid('自建 Registry 包名或版本无效')
  return { name, version: requested }
}

export async function privateNpmPackage(input, requested = 'latest', env = {}) {
  const config = registryConfig(env)
  if (!config.enabled || !config.ready) throw invalid('自建 Registry 查询服务未配置', 503)
  const { name, version } = reference(input, requested, config)
  const result = await createRegistryClient(env).resolve(name, version)
  if (!result.ok) {
    if (result.reason === 'not-found' || result.reason === 'version-not-found')
      throw invalid('自建 Registry 中未找到此包或版本', 404)
    if (result.reason === 'invalid-package') throw invalid('自建 Registry 包名无效')
    throw invalid('自建 Registry 查询失败，请核对服务配置后重试', 502)
  }
  return npmPackageMetadata(name, result.manifest, result.data)
}
