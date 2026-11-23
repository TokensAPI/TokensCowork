export function bearer(request) {
  return /^Bearer ([^\s]{1,512})$/u.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
}
export function text(value, max = 200) { return typeof value === 'string' && value.length <= max && value.trim().length > 0 }
export const idOK = value => typeof value === 'string' && value === value.trim() && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(value)
/** The raw request body, refused (`body too large`) as soon as it passes `limit` bytes. */
export async function bytes(request, limit) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('body required')
  let size = 0
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) { await reader.cancel(); throw new Error('body too large') }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length }
  return all
}
export async function body(request, limit = 16384) {
  const value = JSON.parse(new TextDecoder().decode(await bytes(request, limit)))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value
}
