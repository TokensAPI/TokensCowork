// A few small text files out of an npm package archive (.tgz), with Node's own gzip and a minimal
// tar reader: the archive is streamed and every entry the caller does not pick is skipped unread.
// Used for dsh locale files (package-locale.js) and the CHANGELOG (services/plugin-notes.js).
const MAX_UNPACKED = 64 * 1024 * 1024

function field(bytes, start, length) {
  const value = bytes.subarray(start, start + length), end = value.indexOf(0)
  return new TextDecoder().decode(end < 0 ? value : value.subarray(0, end))
}
function concat(a, b) {
  if (!a.byteLength) return b
  const result = new Uint8Array(a.byteLength + b.byteLength)
  result.set(a); result.set(b, a.byteLength)
  return result
}

/**
 * The text of the regular files `pick(path)` names a key for, keyed by that key (the first entry
 * wins). A file larger than `maxFile` bytes is skipped, and reading stops after `maxFiles` files or
 * a corrupt header; whatever was read by then is returned.
 * @param {Uint8Array} tgz
 * @param {(path: string) => string | undefined} pick
 */
export async function packageFiles(tgz, pick, { maxFile = 64 * 1024, maxFiles = 32 } = {}) {
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
          if (!files.has(entry.key)) files.set(entry.key, new TextDecoder().decode(buffer.subarray(0, entry.size)))
          buffer = buffer.subarray(entry.size); skip = -entry.size & 511; entry = undefined
          if (files.size >= maxFiles) return files
          continue
        }
        if (buffer.byteLength < 512) break
        const header = buffer.subarray(0, 512)
        buffer = buffer.subarray(512)
        if (header.every(byte => byte === 0)) return files
        const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8)
        if (!Number.isSafeInteger(size) || size < 0) return files
        const prefix = field(header, 257, 5) === 'ustar' ? field(header, 345, 155) : ''
        const key = pick(prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
        const regular = header[156] === 0 || header[156] === 48
        if (key !== undefined && regular && size <= maxFile) entry = { key, size }
        else skip = size + (-size & 511)
      }
    }
  } finally { await reader.cancel().catch(() => {}) }
}
