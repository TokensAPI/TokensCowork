const enc=new TextEncoder()
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
function bytes(value){
  if(typeof value!=='string'||!/^([a-f0-9]{2})+$/u.test(value))throw new Error('invalid ciphertext')
  return Uint8Array.from(value.match(/../g),s=>parseInt(s,16))
}
async function encryptionKey(env){
  if(!env.MARKET_KEY_ENCRYPTION_SECRET)throw new Error('key encryption not configured')
  const digest=await crypto.subtle.digest('SHA-256',enc.encode(env.MARKET_KEY_ENCRYPTION_SECRET))
  return crypto.subtle.importKey('raw',digest,'AES-GCM',false,['encrypt','decrypt'])
}
export async function sealKey(value,pluginId,fingerprint,env){
  const iv=crypto.getRandomValues(new Uint8Array(12))
  const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(pluginId+':'+fingerprint)},await encryptionKey(env),enc.encode(value))
  return hex(iv)+'.'+hex(new Uint8Array(sealed))
}
export async function openKey(value,pluginId,fingerprint,env){
  const [iv,ciphertext]=value.split('.')
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:enc.encode(pluginId+':'+fingerprint)},await encryptionKey(env),bytes(ciphertext))
  return new TextDecoder().decode(plain)
}
