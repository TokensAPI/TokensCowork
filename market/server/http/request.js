export function bearer(request) {
  return /^Bearer ([^\s]{1,512})$/u.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
}
export function text(value, max = 200) { return typeof value === 'string' && value.length <= max && value.trim().length > 0 }
export const idOK = value => typeof value === 'string' && value === value.trim() && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(value)
export async function body(request) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('body required')
  let size = 0
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 16384) { await reader.cancel(); throw new Error('body too large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const value = JSON.parse(new TextDecoder().decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value
}
