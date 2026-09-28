import { fingerprint } from './key-fingerprint.js'

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 8

// Scopes share one table but never one another's budget: a service client fumbling its token
// must not lock a human administrator out of the console, or the reverse.
async function bucket(request, env, scope) {
  // Cloudflare supplies this header at the edge. Do not trust X-Forwarded-For.
  // Keep only a keyed digest in storage, never the visitor's raw IP address.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  return fingerprint(scope + ':' + ip, env.MARKET_HMAC_SECRET)
}

function remaining(row, now) {
  return row && row.failure_count >= MAX_FAILURES && row.expires_at > now
    ? Math.ceil((row.expires_at - now) / 1000)
    : 0
}

export async function adminLoginWait(request, env, scope = 'market-admin-login') {
  const row = await env.MARKET_DB.prepare(
    'SELECT failure_count,expires_at FROM market_login_limits WHERE bucket_hash=?',
  ).bind(await bucket(request, env, scope)).first()
  return remaining(row, Date.now())
}

export async function recordAdminLoginFailure(request, env, scope = 'market-admin-login') {
  const hash = await bucket(request, env, scope)
  const now = Date.now()
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM market_login_limits WHERE expires_at<=?').bind(now),
    env.MARKET_DB.prepare(`INSERT INTO market_login_limits(bucket_hash,failure_count,expires_at)
      VALUES(?,1,?) ON CONFLICT(bucket_hash) DO UPDATE SET
      failure_count=market_login_limits.failure_count+1`).bind(hash, now + WINDOW_MS),
  ])
  const row = await env.MARKET_DB.prepare(
    'SELECT failure_count,expires_at FROM market_login_limits WHERE bucket_hash=?',
  ).bind(hash).first()
  return remaining(row, now)
}

export async function clearAdminLoginFailures(request, env, scope = 'market-admin-login') {
  await env.MARKET_DB.prepare('DELETE FROM market_login_limits WHERE bucket_hash=?')
    .bind(await bucket(request, env, scope)).run()
}
