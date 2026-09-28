import { fingerprint } from '../security/key-fingerprint.js'
import { sealKey, openKey } from '../security/key-vault.js'
import { auditStatements } from './audit.js'
import { invalid, fingerprintOK } from './plugins.js'

// The Key directory: one row per `sk-` Key the platform grants plugins to directly. Matching and
// URLs use a keyed fingerprint; the raw value is kept sealed so the console can show it, and only
// when an encryption secret is configured.
const labelOK = value => typeof value === 'string' && value.trim() && value.length <= 120

async function grantsByKey(env, fp = null) {
  const { results } = await (fp
    ? env.MARKET_DB.prepare("SELECT subject,plugin_id FROM market_grants WHERE kind='key' AND subject=? ORDER BY plugin_id").bind(fp)
    : env.MARKET_DB.prepare("SELECT subject,plugin_id FROM market_grants WHERE kind='key' ORDER BY plugin_id")).all()
  const grants = new Map()
  for (const row of results) grants.set(row.subject, [...grants.get(row.subject) ?? [], row.plugin_id])
  return grants
}
// A value that no longer opens (rotated secret) is reported as absent rather than failing the read.
async function rawValue(env, row) {
  if (!row.encrypted_value || !env.MARKET_KEY_ENCRYPTION_SECRET) return null
  try { return await openKey(row.encrypted_value, row.sealed_for, row.fingerprint, env) } catch { return null }
}
const view = async (env, row, grants) => ({
  fingerprint: row.fingerprint, apiKey: await rawValue(env, row), label: row.label, createdAt: row.created_at,
  stored: row.encrypted_value !== null, plugins: grants.get(row.fingerprint) ?? [],
})

export async function listKeys(env) {
  const [{ results }, grants] = await Promise.all([
    env.MARKET_DB.prepare('SELECT fingerprint,label,encrypted_value,sealed_for,created_at FROM market_keys ORDER BY label=\'\',label,fingerprint').all(),
    grantsByKey(env),
  ])
  return { items: await Promise.all(results.map(row => view(env, row, grants))), displayReady: Boolean(env.MARKET_KEY_ENCRYPTION_SECRET) }
}

async function keyRow(env, fp) {
  if (!fingerprintOK(fp)) throw invalid('Key 指纹无效')
  const row = await env.MARKET_DB.prepare('SELECT * FROM market_keys WHERE fingerprint=?').bind(fp).first()
  if (!row) throw invalid('Key 不存在', 404)
  return row
}

export async function getKey(env, fp) {
  return view(env, await keyRow(env, fp), await grantsByKey(env, fp))
}

export async function addKey(env, data, actor) {
  if (typeof data?.key !== 'string' || !/^sk-\S{1,509}$/u.test(data.key)) throw invalid('API Key 格式无效，应以 sk- 开头')
  const label = data.label ?? ''
  if (label !== '' && !labelOK(label)) throw invalid('备注最多 120 个字符')
  const fp = await fingerprint(data.key, env.MARKET_HMAC_SECRET)
  if (await env.MARKET_DB.prepare('SELECT 1 FROM market_keys WHERE fingerprint=?').bind(fp).first()) throw invalid('该 Key 已登记', 409)
  const sealed = env.MARKET_KEY_ENCRYPTION_SECRET ? await sealKey(data.key, 'key', fp, env) : null
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare("INSERT INTO market_keys(fingerprint,label,encrypted_value,sealed_for,created_at) VALUES(?,?,?,'key',?)")
      .bind(fp, label.trim(), sealed, Date.now()),
    ...auditStatements(env, 'key.added', fp, {}, actor),
  ])
  return { ok: true, fingerprint: fp }
}

export async function updateKey(env, fp, data, actor) {
  await keyRow(env, fp)
  if (typeof data?.label !== 'string' || (data.label !== '' && !labelOK(data.label))) throw invalid('备注最多 120 个字符')
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('UPDATE market_keys SET label=? WHERE fingerprint=?').bind(data.label.trim(), fp),
    ...auditStatements(env, 'key.updated', fp, {}, actor),
  ])
  return { ok: true }
}

// Removing a Key removes every plugin grant it held.
export async function deleteKey(env, fp, actor) {
  await keyRow(env, fp)
  const grants = (await grantsByKey(env, fp)).get(fp) ?? []
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare("DELETE FROM market_grants WHERE kind='key' AND subject=?").bind(fp),
    env.MARKET_DB.prepare('DELETE FROM market_keys WHERE fingerprint=?').bind(fp),
    ...auditStatements(env, 'key.deleted', fp, { grantCount: grants.length }, actor),
  ])
  return { ok: true }
}
