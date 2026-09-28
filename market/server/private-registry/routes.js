import { reply } from '../http/response.js'
import { allowed } from '../services/access.js'
import { packageOK, versionOK } from '../services/plugins.js'
import { createRegistryClient } from './client.mjs'
import { canServeRegistryPackage } from '../services/catalog-source-service.js'

const pluginId = /^[a-z0-9][a-z0-9-]{0,79}$/u

function pathParts(url) {
  const raw = url.pathname.slice('/registry/'.length).split('/').filter(Boolean)
  try { return raw.map(value => decodeURIComponent(value)) } catch { return undefined }
}

async function privatePackage(request, env, id, name) {
  if (!pluginId.test(id) || !packageOK(name)) return undefined
  const row = await env.MARKET_DB.prepare("SELECT * FROM market_plugins WHERE id=? AND state='published'").bind(id).first()
  if (!row) return undefined
  let metadata
  try { metadata = JSON.parse(row.metadata) } catch { return undefined }
  if (!canServeRegistryPackage(metadata) || metadata.package !== name) return undefined
  // Visibility is decided in the admin backend, nowhere else, and through the same
  // function the catalog uses so installing can never diverge from listing. The Registry is
  // storage — the proxy always fetches with the service account, so which scope
  // hosts the package never affects who can install the plugin.
  if (!await allowed(request, env, id)) return undefined
  return { id, name, metadata }
}

function tarballUrl(requestUrl, id, name, version) {
  return new URL(`/registry/${encodeURIComponent(id)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/tarball`, requestUrl).toString()
}

async function metadataResponse(request, env, id, name) {
  const item = await privatePackage(request, env, id, name)
  if (!item) return reply({ error: '插件不存在或没有下载权限' }, 403)
  const client = createRegistryClient(env)
  if (!client.status().ready) return reply({ error: '私有 Registry 未配置' }, 503)
  const result = await client.metadata(name)
  if (!result.ok) return reply({ error: result.reason === 'not-found' ? '私有 Registry 未找到此包' : '私有 Registry 暂时不可用' }, result.reason === 'not-found' ? 404 : 503)
  const versions = {}
  for (const [key, value] of Object.entries(result.data.versions)) {
    if (!versionOK(key) || !value || typeof value !== 'object' || value.name !== name || value.version !== key) continue
    const dist = value.dist
    if (!dist || typeof dist !== 'object' || typeof dist.tarball !== 'string') continue
    versions[key] = {
      ...value,
      dist: { ...dist, tarball: tarballUrl(request.url, id, name, key) },
    }
  }
  if (!Object.keys(versions).length) return reply({ error: '私有 Registry 返回的包元数据无效' }, 502)
  return reply({ ...result.data, name, versions })
}

async function tarballResponse(request, env, id, name, version) {
  if (!versionOK(version)) return reply({ error: '版本无效' }, 400)
  const item = await privatePackage(request, env, id, name)
  if (!item) return reply({ error: '插件不存在或没有下载权限' }, 403)
  const client = createRegistryClient(env)
  if (!client.status().ready) return reply({ error: '私有 Registry 未配置' }, 503)
  const result = await client.resolve(name, version)
  if (!result.ok) return reply({ error: result.reason === 'version-not-found' ? '私有 Registry 未找到此版本' : '私有 Registry 暂时不可用' }, result.reason === 'version-not-found' ? 404 : 503)
  const packageResult = await client.tarball(result.tarball)
  if (!packageResult.ok) return reply({ error: '私有 Registry 安装包暂时不可用' }, 503)
  return new Response(packageResult.bytes, {
    headers: {
      'content-type': packageResult.contentType,
      'cache-control': 'private, no-store',
      vary: 'Authorization',
      'content-disposition': `attachment; filename="${encodeURIComponent(name.replace(/^@/u, '').replaceAll('/', '-'))}-${version}.tgz"`,
    },
  })
}

export async function registryRoute(request, env) {
  const url = new URL(request.url)
  if (request.method !== 'GET') return reply({ error: 'method not allowed' }, 405)
  if (!env.MARKET_DB || !env.MARKET_HMAC_SECRET) return reply({ error: '授权服务未配置' }, 503)
  const parts = pathParts(url)
  if (!parts || parts.length < 2) return reply({ error: 'Registry 路径无效' }, 400)
  let id = parts.shift()
  if (id === 'by-package') {
    // Shared scoped Registry metadata endpoint. Tarball URLs retain the real
    // plugin ID so every archive request repeats the same ACL check.
    const name = parts.join('/')
    if (!packageOK(name)) return reply({ error: 'Invalid package name' }, 400)
    const { results } = await env.MARKET_DB.prepare("SELECT id FROM market_plugins WHERE state='published' AND json_extract(metadata,'$.package')=? LIMIT 2").bind(name).all()
    if (results.length !== 1) return reply({ error: '插件不存在或没有下载权限' }, 403)
    id = results[0].id
    return metadataResponse(request, env, id, name)
  }
  const last = parts.at(-1)
  if (last === 'tarball' && parts.length >= 3) {
    parts.pop()
    const version = parts.pop()
    return tarballResponse(request, env, id, parts.join('/'), version)
  }
  return metadataResponse(request, env, id, parts.join('/'))
}
