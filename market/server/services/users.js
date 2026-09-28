import { auditStatements } from './audit.js'
import { invalid } from './plugins.js'
import { validOrganizationId, userSearchReady } from './organizations.js'

// The user directory: TokensAPI users an administrator grants plugins to directly. TokensAPI owns
// the accounts; the market keeps only the user number and a display name for the console, and a
// grant follows the user whichever organization or Key they happen to use.
const nameOK = value => typeof value === 'string' && value.trim() && value.length <= 200

async function grantsByUser(env, id = null) {
  const { results } = await (id
    ? env.MARKET_DB.prepare("SELECT subject,plugin_id FROM market_grants WHERE kind='user' AND subject=? ORDER BY plugin_id").bind(String(id))
    : env.MARKET_DB.prepare("SELECT subject,plugin_id FROM market_grants WHERE kind='user' ORDER BY plugin_id")).all()
  const grants = new Map()
  for (const row of results) grants.set(Number(row.subject), [...grants.get(Number(row.subject)) ?? [], row.plugin_id])
  return grants
}
const view = (row, grants) => ({ id: row.id, name: row.name, createdAt: row.created_at, plugins: grants.get(row.id) ?? [] })

export async function listUsers(env) {
  const [{ results }, grants] = await Promise.all([
    env.MARKET_DB.prepare('SELECT id,name,created_at FROM market_users ORDER BY name,id').all(),
    grantsByUser(env),
  ])
  return { items: results.map(row => view(row, grants)), searchReady: userSearchReady(env) }
}

async function userRow(env, id) {
  if (!validOrganizationId(id)) throw invalid('用户号无效')
  const row = await env.MARKET_DB.prepare('SELECT id,name,created_at FROM market_users WHERE id=?').bind(id).first()
  if (!row) throw invalid('用户不存在', 404)
  return row
}

export async function getUser(env, id) {
  return view(await userRow(env, id), await grantsByUser(env, id))
}

// Adding a user to the directory, or refreshing the name shown for them.
export async function saveUser(env, id, data, actor) {
  if (!validOrganizationId(id)) throw invalid('用户号无效')
  if (!nameOK(data?.name)) throw invalid('请填写用户名称，最多 200 个字符')
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('INSERT INTO market_users(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name')
      .bind(id, data.name.trim(), Date.now()),
    ...auditStatements(env, 'user.updated', id, {}, actor),
  ])
  return { ok: true }
}

// Removing a user removes every plugin grant they held.
export async function deleteUser(env, id, actor) {
  await userRow(env, id)
  const grants = (await grantsByUser(env, id)).get(id) ?? []
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare("DELETE FROM market_grants WHERE kind='user' AND subject=?").bind(String(id)),
    env.MARKET_DB.prepare('DELETE FROM market_users WHERE id=?').bind(id),
    ...auditStatements(env, 'user.deleted', id, { grantCount: grants.length }, actor),
  ])
  return { ok: true }
}
