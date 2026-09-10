import { registryConfig } from './config.mjs'
const packageName = /^(?:@[a-z0-9-~][a-z0-9._~-]*\/)?[a-z0-9-~][a-z0-9._~-]*$/u
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
function validPackageVersion(value) { return typeof value === 'string' && value.length <= 64 && version.test(value) }
function stable(value) { return typeof value === 'string' && stableVersion.test(value) }
function packagePath(name) { return encodeURIComponent(name) }
function safeHttps(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.toString()
      : undefined
  } catch { return undefined }
}
export function createRegistryClient(env, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const config = registryConfig(env)
  async function request(url, options = {}, maxBytes = 4 * 1024 * 1024) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000)
    try {
      const response = await fetchImpl(url, {
        ...options,
        headers: {
          Authorization: config.authorization,
          Accept: 'application/json',
          ...(options.headers ?? {}),
        },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        return { ok: false, reason: response.status === 404 ? 'not-found' : 'registry-unavailable' }
      }
      const reader = response.body?.getReader()
      if (!reader) return { ok: false, reason: 'invalid-response' }
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) { await reader.cancel(); return { ok: false, reason: 'response-too-large' } }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return { ok: true, response, bytes }
    } catch { return { ok: false, reason: 'registry-unavailable' } }
    finally { clearTimeout(timer) }
  }
  return {
    status: () => ({ enabled: config.enabled, ready: config.ready === true, ...(config.reason ? { reason: config.reason } : {}) }),
    async metadata(name) {
      if (!config.enabled) return { ok: false, reason: 'disabled' }
      if (!config.ready) return { ok: false, reason: config.reason }
      if (typeof name !== 'string' || name.length > 160 || name !== name.trim() || !packageName.test(name)) return { ok: false, reason: 'invalid-package' }
      try {
        const result = await request(new URL(packagePath(name), config.url))
        if (!result.ok) return result
        const data = JSON.parse(new TextDecoder().decode(result.bytes))
        if (data.name !== name || !data.versions || typeof data.versions !== 'object' || Array.isArray(data.versions)) return { ok: false, reason: 'invalid-response' }
        return { ok: true, data }
      } catch { return { ok: false, reason: 'invalid-response' } }
    },
    async resolve(name, requested = 'latest') {
      const result = await this.metadata(name)
      if (!result.ok) return result
      const tags = result.data['dist-tags']
      const selected = requested === 'latest' ? tags?.latest : requested
      if (!validPackageVersion(selected) || !result.data.versions[selected]) return { ok: false, reason: 'version-not-found' }
      const manifest = result.data.versions[selected]
      const tarball = safeHttps(manifest?.dist?.tarball)
      if (manifest.name !== name || manifest.version !== selected || !tarball) return { ok: false, reason: 'invalid-response' }
      return {
        ok: true,
        name,
        version: selected,
        stable: stable(selected),
        tarball,
        integrity: typeof manifest.dist?.integrity === 'string' ? manifest.dist.integrity : undefined,
        manifest,
        data: result.data,
      }
    },
    async latestVersion(name) {
      const result = await this.resolve(name, 'latest')
      return result.ok && result.stable ? result.version : undefined
    },
    async tarball(url) {
      if (!config.enabled) return { ok: false, reason: 'disabled' }
      if (!config.ready) return { ok: false, reason: config.reason }
      const safe = safeHttps(url)
      if (!safe) return { ok: false, reason: 'invalid-url' }
      if (new URL(safe).origin !== new URL(config.url).origin) return { ok: false, reason: 'invalid-url' }
      const result = await request(safe, { headers: { Accept: 'application/octet-stream' } }, 64 * 1024 * 1024)
      if (!result.ok) return result
      return { ok: true, bytes: result.bytes, contentType: result.response.headers.get('content-type') || 'application/octet-stream' }
    },
  }
}
