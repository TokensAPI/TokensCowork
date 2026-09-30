import { bearer, text } from '../http/request.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { organizationSessionReady, resolveSiteAccount, resolveSiteOrganization } from './organizations.js'
import { invalid } from './plugins.js'

// Two kinds of console user, one session table:
//   platform      — the market's own admin token (as a Bearer header, or signed in with it);
//                   acts on the whole market. organization_id is NULL in its session row.
//   organization  — a TokensAPI account that administers an organization registered and enabled
//                   here; acts on that organization's plugin switches only.
// Anyone else is refused at sign-in: the market has nothing for them to configure.
export const TENANT_ADMIN_ROLE = 10 // TokensAPI's OrgRoleAdmin.

const NAME = '__Host-market_session'
const TTL = 7 * 24 * 60 * 60
const enc = new TextEncoder()
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))))
// Rotating the admin token or the HMAC secret ends every session at once.
const version = env => digest(env.MARKET_HMAC_SECRET + '\0' + env.MARKET_ADMIN_TOKEN)
const cookieValue = request => request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(NAME + '='))?.slice(NAME.length + 1) ?? ''
const cookie = (value, age) => NAME + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + age

const platform = (via, operator = null) => ({ role: 'platform', organizationId: null, via,
  actor: { kind: 'root', id: operator?.id ?? (via === 'bearer' ? 'token' : 'session'), organizationId: operator?.organizationId ?? null } })
const positive = value => /^[1-9][0-9]{0,15}$/u.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : null
// TokensAPI calling with the admin token may name the person it acts for. The claim is only written
// to the audit log and never grants or narrows anything: the token alone decides what is allowed.
function operator(request) {
  const id = positive(request.headers.get('x-tokensapi-operator-id'))
  return id ? { id: 'tokensapi:' + id, organizationId: positive(request.headers.get('x-tokensapi-operator-org-id')) } : null
}
const organization = (organizationId, userId) => ({ role: 'organization', organizationId, via: 'session',
  actor: { kind: 'tenant', id: String(userId ?? ''), organizationId } })
export const isPlatform = principal => principal?.role === 'platform'

export async function adminTokenMatches(value, env) {
  if (!value || !env.MARKET_ADMIN_TOKEN || !env.MARKET_HMAC_SECRET) return false
  return await fingerprint(value, env.MARKET_HMAC_SECRET) === await fingerprint(env.MARKET_ADMIN_TOKEN, env.MARKET_HMAC_SECRET)
}

/**
 * Who is calling: a platform or organization principal, or null. A Bearer header is decisive —
 * a wrong one is refused outright rather than falling back to a cookie riding along with it.
 */
export async function resolvePrincipal(request, env) {
  const token = bearer(request)
  if (token) return await adminTokenMatches(token, env) ? platform('bearer', operator(request)) : null
  const value = cookieValue(request)
  if (!/^[a-f0-9]{64}$/u.test(value) || !env.MARKET_ADMIN_TOKEN) return null
  // The organization comes from the session row, and disabling it ends the session.
  const row = await env.MARKET_DB.prepare(`SELECT s.organization_id,s.user_id FROM market_sessions s
    LEFT JOIN market_organizations o ON o.id=s.organization_id
    WHERE s.token_hash=? AND s.expires_at>? AND s.credential_version=? AND (s.organization_id IS NULL OR o.enabled=1)`)
    .bind(await digest(value), Date.now(), await version(env)).first()
  if (!row) return null
  return row.organization_id === null ? platform('session') : organization(row.organization_id, row.user_id)
}

// The TokensAPI credential the person pastes: the access token from their TokensAPI settings and
// the account id TokensAPI demands beside it. Forwarded for the two sign-in lookups only — never
// stored, cached or logged. Afterwards the market carries its own session.
async function tokensApiSeat(data, env) {
  const userId = Number(data?.userId)
  if (!text(data?.accessToken, 4096) || !Number.isSafeInteger(userId) || userId <= 0) throw invalid('请填写 TokensAPI 用户 ID 与访问令牌', 401)
  if (!organizationSessionReady(env)) throw invalid('未配置 TokensAPI 登录', 401)
  const credential = { accessToken: data.accessToken.trim(), userId }
  let account, org
  try {
    account = await resolveSiteAccount(credential, env)
    org = account && await resolveSiteOrganization(credential, env)
  } catch { throw invalid('无法连接 TokensAPI 登录服务，请稍后重试', 503) }
  if (!account) throw invalid('TokensAPI 用户 ID 或访问令牌无效', 401)
  if (!org || org.role < TENANT_ADMIN_ROLE) throw invalid('只有组织管理员可以登录市场后台', 401)
  if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_organizations WHERE id=? AND enabled=1').bind(org.id).first())
    throw invalid('你的组织尚未在市场登记或已停用，请联系平台管理员', 401)
  return { organizationId: org.id, userId: account.id }
}

/** Signs in with the admin token or a TokensAPI account and returns the Set-Cookie value. */
export async function login(request, env, data) {
  let seat
  if (data?.tokensapi === true) seat = await tokensApiSeat(data, env)
  else if (text(data?.credential, 512) && await adminTokenMatches(data.credential, env)) seat = { organizationId: null, userId: null }
  else throw invalid('后台口令无效', 401)
  const value = hex(crypto.getRandomValues(new Uint8Array(32)))
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM market_sessions WHERE expires_at<=? OR token_hash=?').bind(Date.now(), await digest(cookieValue(request))),
    env.MARKET_DB.prepare('INSERT INTO market_sessions(token_hash,organization_id,user_id,expires_at,credential_version) VALUES(?,?,?,?,?)')
      .bind(await digest(value), seat.organizationId, seat.userId, Date.now() + TTL * 1000, await version(env)),
  ])
  return cookie(value, TTL)
}

export async function logout(request, env) {
  await env.MARKET_DB.prepare('DELETE FROM market_sessions WHERE expires_at<=? OR token_hash=?').bind(Date.now(), await digest(cookieValue(request))).run()
  return cookie('', 0)
}
