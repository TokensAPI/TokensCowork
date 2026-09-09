import { fingerprint } from './key-fingerprint.js'

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 8

async function bucket(request, env) {
  // Cloudflare supplies this header at the edge. Do not trust X-Forwarded-For.
  // Keep only a keyed digest in storage, never the visitor's raw IP address.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  return fingerprint('market-admin-login:' + ip, env.MARKET_HMAC_SECRET)
}

function remaining(row, now) {
  return row && row.failure_count >= MAX_FAILURES && row.expires_at > now
    ? Math.ceil((row.expires_at - now) / 1000)
    : 0
}

export async function adminLoginWait(request, env) {
  const row = await env.MARKET_DB.prepare(
    'SELECT failure_count,expires_at FROM market_admin_login_limits WHERE bucket_hash=?',
  ).bind(await bucket(request, env)).first()
  return remaining(row, Date.now())
}

export async function recordAdminLoginFailure(request, env) {
  const hash = await bucket(request, env)
  const now = Date.now()
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('DELETE FROM market_admin_login_limits WHERE expires_at<=?').bind(now),
    env.MARKET_DB.prepare(`INSERT INTO market_admin_login_limits(bucket_hash,failure_count,expires_at)
      VALUES(?,1,?) ON CONFLICT(bucket_hash) DO UPDATE SET
      failure_count=market_admin_login_limits.failure_count+1`).bind(hash, now + WINDOW_MS),
  ])
  const row = await env.MARKET_DB.prepare(
    'SELECT failure_count,expires_at FROM market_admin_login_limits WHERE bucket_hash=?',
  ).bind(hash).first()
  return remaining(row, now)
}

export async function clearAdminLoginFailures(request, env) {
  await env.MARKET_DB.prepare('DELETE FROM market_admin_login_limits WHERE bucket_hash=?')
    .bind(await bucket(request, env)).run()
}
