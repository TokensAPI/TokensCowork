// dsh plugin display metadata: `locale/<lang>.json` → `meta.title` / `meta.description`.
// It only ships inside the package tarball, so the archive is streamed and every other file is skipped unread.
const MAX_UNPACKED = 64 * 1024 * 1024, MAX_FILE = 64 * 1024, MAX_FILES = 32
const localeFile = /^[^/]+\/locale\/([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.json$/iu

// dsh discovers these files through the `./locale/*.json` export; packages without it have no dsh metadata.
export function declaresLocaleFiles(manifest) {
  const exports = manifest?.exports
  return !!exports && typeof exports === 'object' && !Array.isArray(exports)
    && Object.keys(exports).some(key => key === './locale/*.json' || /^\.\/locale\/[^/]+\.json$/u.test(key))
}
function text(bytes, start, length) {
  const field = bytes.subarray(start, start + length), end = field.indexOf(0)
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end))
}
function concat(a, b) {
  if (!a.byteLength) return b
  const result = new Uint8Array(a.byteLength + b.byteLength)
  result.set(a); result.set(b, a.byteLength)
  return result
}
async function localeFiles(tgz) {
  const reader = new Blob([tgz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const files = new Map()
  let buffer = new Uint8Array(0), skip = 0, entry, total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return files
      if ((total += value.byteLength) > MAX_UNPACKED) return files
      buffer = concat(buffer, value)
      for (;;) {
        if (skip) {
          const n = Math.min(skip, buffer.byteLength)
          buffer = buffer.subarray(n); skip -= n
          if (skip) break
        }
        if (entry) {
          if (buffer.byteLength < entry.size) break
          files.set(entry.language, new TextDecoder().decode(buffer.subarray(0, entry.size)))
          buffer = buffer.subarray(entry.size); skip = -entry.size & 511; entry = undefined
          continue
        }
        if (buffer.byteLength < 512) break
        const header = buffer.subarray(0, 512)
        buffer = buffer.subarray(512)
        if (header.every(byte => byte === 0)) return files
        const size = Number.parseInt(text(header, 124, 12).trim() || '0', 8)
        if (!Number.isSafeInteger(size) || size < 0) return files
        const prefix = text(header, 257, 5) === 'ustar' ? text(header, 345, 155) : ''
        const match = localeFile.exec(prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))
        const regular = header[156] === 0 || header[156] === 48
        if (match && regular && size <= MAX_FILE && files.size < MAX_FILES) entry = { language: match[1], size }
        else skip = size + (-size & 511)
      }
    }
  } finally { await reader.cancel().catch(() => {}) }
}
export async function packageLocaleMetadata(tgz) {
  const title = {}, description = {}
  for (const [language, source] of await localeFiles(tgz)) {
    let meta
    try { meta = JSON.parse(source)?.meta } catch { continue }
    if (!meta || typeof meta !== 'object') continue
    if (typeof meta.title === 'string') title[language] = meta.title
    if (typeof meta.description === 'string') description[language] = meta.description
  }
  return { title, description }
}
