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
  /** Buffered JSON request: metadata only, archives stream instead. */
  async function request(url) {
    const maxBytes = 4 * 1024 * 1024
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000)
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: config.authorization, Accept: 'application/json' },
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
    /**
     * Forward an archive as a stream. Buffering the whole package first made
     * the client's time to first byte grow with the package size and made the
     * upstream deadline a size limit; the caller pipes the body straight
     * through and verifies integrity while it passes.
     */
    async tarball(url) {
      if (!config.enabled) return { ok: false, reason: 'disabled' }
      if (!config.ready) return { ok: false, reason: config.reason }
      const safe = safeHttps(url)
      if (!safe) return { ok: false, reason: 'invalid-url' }
      if (new URL(safe).origin !== new URL(config.url).origin) return { ok: false, reason: 'invalid-url' }
      const controller = new AbortController()
      // Cleared as soon as the headers arrive: the deadline must not abort a
      // body that is still being delivered to the installing client.
      const timer = setTimeout(() => controller.abort(), config.tarballTimeoutMs ?? 20000)
      try {
        const response = await fetchImpl(safe, {
          headers: { Authorization: config.authorization, Accept: 'application/octet-stream' },
          redirect: 'manual',
          signal: controller.signal,
        })
        if (!response.ok) {
          await response.body?.cancel()
          return { ok: false, reason: response.status === 404 ? 'not-found' : 'registry-unavailable' }
        }
        if (!response.body) return { ok: false, reason: 'invalid-response' }
        // Only a declared length is forwarded; an absent header must not turn
        // into content-length: 0 and truncate the archive.
        const declared = response.headers.get('content-length')?.trim()
        const length = declared ? Number(declared) : Number.NaN
        return {
          ok: true,
          body: response.body,
          contentType: response.headers.get('content-type') || 'application/octet-stream',
          ...(Number.isSafeInteger(length) && length >= 0 ? { contentLength: length } : {}),
        }
      } catch { return { ok: false, reason: 'registry-unavailable' } }
      finally { clearTimeout(timer) }
    },
    /**
     * Buffer a whole archive, bounded, for the one caller that has to look
     * inside it (catalog locale files) instead of forwarding it. Downloads
     * stream -- see tarball(). The archive deadline covers the headers only,
     * so reading the body gets the ordinary request budget back: unlike an
     * installing client, nothing here waits on a slow end user.
     */
    async tarballBytes(url, maxBytes = 64 * 1024 * 1024) {
      const result = await this.tarball(url)
      if (!result.ok) return result
      const reader = result.body.getReader()
      let expired = false
      const deadline = setTimeout(() => {
        expired = true
        void reader.cancel().catch(() => {})
      }, config.timeoutMs ?? 8000)
      try {
        const chunks = []
        let size = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) { await reader.cancel(); return { ok: false, reason: 'response-too-large' } }
          chunks.push(value)
        }
        // A cancelled read reports completion, so the deadline is what tells a
        // finished archive apart from a truncated one.
        if (expired) return { ok: false, reason: 'registry-unavailable' }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        return { ok: true, bytes, contentType: result.contentType }
      } catch { return { ok: false, reason: 'registry-unavailable' } }
      finally { clearTimeout(deadline) }
    },
  }
}
