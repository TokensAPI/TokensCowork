import { packageOK, stable, versionOK, invalid } from '../services/catalog-service.js'
import { readmeSummary } from './npm-readme.js'

export function npmReference(input, version = 'latest') {
  if (typeof input !== 'string' || input.length > 512) throw invalid('请输入 npm 包名或 npmjs.com 包链接')
  let name = input.trim(), linkedVersion
  if (/^https?:/iu.test(name)) {
    let decoded
    try { decoded = decodeURIComponent(name.split(/[?#]/u)[0]) } catch { throw invalid('npm 链接编码无效') }
    if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(decoded) || decoded.includes('\\')) throw invalid('npm 链接路径无效')
    let url
    try { url = new URL(name) } catch { throw invalid('npm 链接无效') }
    if (url.protocol !== 'https:' || !['www.npmjs.com', 'npmjs.com'].includes(url.hostname) || url.port || url.username || url.password)
      throw invalid('仅支持 https://www.npmjs.com/package/ 包链接')
    let path
    try { path = decodeURIComponent(url.pathname) } catch { throw invalid('npm 链接编码无效') }
    const match = /^\/package\/((?:@[^/]+\/)?[^/]+?)(?:\/v\/([^/]+))?\/?$/u.exec(path)
    if (!match) throw invalid('请粘贴 npm 包详情页链接')
    name = match[1]; linkedVersion = match[2]
  }
  const selectedVersion = version === 'latest' && linkedVersion ? linkedVersion : version
  if (!packageOK(name) || (selectedVersion !== 'latest' && !versionOK(selectedVersion)))
    throw invalid('npm 包名或版本无效')
  return { name, version: selectedVersion }
}

async function registry(path) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch('https://registry.npmjs.org/' + path, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'application/json' },
      cf: { cacheTtl: 120, cacheEverything: true },
    })
    if (!response.ok)
      throw invalid(
        response.status === 404
          ? 'npm 上未找到此包或版本'
          : 'npm 查询失败，请稍后重试',
        502,
      )
    const reader = response.body.getReader()
    let size = 0
    const chunks = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2 * 1024 * 1024) {
        await reader.cancel()
        throw invalid('npm 响应过大', 502)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    if (error.status) throw error
    throw invalid('npm 请求超时或响应无效，请稍后重试', 502)
  } finally {
    clearTimeout(timer)
  }
}
export async function npmPackage(name, version = 'latest') {
  ;({ name, version } = npmReference(name, version))
  const value = await registry(encodeURIComponent(name) + '/' + encodeURIComponent(version))
  if (value.name !== name || !versionOK(value.version) || (version !== 'latest' && value.version !== version))
    throw invalid('npm 未返回对应的有效版本', 502)
  const repo =
    typeof value.repository === 'string'
      ? value.repository
      : value.repository?.url
  let suggestion = '', readmeNotice = ''
  try {
    const packument = await registry(encodeURIComponent(name))
    if (packument.name === name) {
      suggestion = readmeSummary(packument.readme)
      if (suggestion) readmeNotice = '来自 npm 当前 README，可能与指定历史版本不同，请核对后采用。'
    }
  } catch { readmeNotice = 'README 暂时无法读取，不影响使用包描述或手工填写简介。' }
  return {
    readmeSummary: suggestion,
    readmeNotice,
    suggestedId: name.replace(/^@/u, '').replace(/[^a-z0-9-]+/gu, '-').replace(/^-+/u, '').slice(0, 80) || 'plugin',
    license: typeof value.license === 'string' ? value.license.slice(0, 160) : '',
    prerelease: !stable(value.version),
    package: name,
    version: value.version,
    displayName: name.split('/').pop(),
    summary:
      typeof value.description === 'string'
        ? value.description.slice(0, 1000)
        : '',
    repository:
      typeof repo === 'string'
        ? repo.replace(/^git\+/u, '').replace(/\.git$/u, '')
        : '',
    npm: true,
    category: 'optional',
  }
}
export async function latestVersion(name, fallback) {
  try {
    if (!packageOK(name)) return fallback
    const value = await registry('-/package/' + name + '/dist-tags')
    return stable(value.latest) ? value.latest : fallback
  } catch {
    return fallback
  }
}
