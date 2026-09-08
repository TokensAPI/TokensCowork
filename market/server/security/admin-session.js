const NAME='__Host-market_session'
const TTL=7*24*60*60
const enc=new TextEncoder()
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
const digest=async value=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))))
const version=env=>digest(env.MARKET_HMAC_SECRET+'\0'+env.MARKET_ADMIN_TOKEN)
function token(request){return request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(NAME+'='))?.slice(NAME.length+1)??''}
const cookie=(value,age)=>NAME+'='+value+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+age
export async function validSession(request,env){
  const value=token(request)
  if(!/^[a-f0-9]{64}$/u.test(value)||!env.MARKET_ADMIN_TOKEN)return false
  return !!await env.MARKET_DB.prepare('SELECT 1 FROM market_admin_sessions WHERE token_hash=? AND expires_at>? AND credential_version=?').bind(await digest(value),Date.now(),await version(env)).first()
}
export async function createSession(request,env){
  const value=hex(crypto.getRandomValues(new Uint8Array(32))),old=token(request)
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM market_admin_sessions WHERE expires_at<=? OR token_hash=?').bind(Date.now(),await digest(old)),
    env.MARKET_DB.prepare('INSERT INTO market_admin_sessions(token_hash,expires_at,credential_version) VALUES(?,?,?)').bind(await digest(value),Date.now()+TTL*1000,await version(env))
  ])
  return cookie(value,TTL)
}
export async function endSession(request,env){
  await env.MARKET_DB.prepare('DELETE FROM market_admin_sessions WHERE token_hash=?').bind(await digest(token(request))).run()
  return cookie('',0)
}
