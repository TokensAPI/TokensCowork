const enc = new TextEncoder()
export async function fingerprint(key, secret) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(key))), b => b.toString(16).padStart(2, '0')).join('')
}
