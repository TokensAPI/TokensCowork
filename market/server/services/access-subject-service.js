import { fingerprint } from '../security/key-fingerprint.js'
import { sealKey } from '../security/key-vault.js'
import { auditStatements } from './admin-audit-service.js'
import { revisionStatement } from './catalog-service.js'

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
export async function accessSubjects(env) {
  const query = async sql => (await env.MARKET_DB.prepare(sql).all()).results
  const [annotations, keys, organizations, plugins, direct, legacy, orgGrants, policies] = await Promise.all([
    query('SELECT kind,id,label,notes,tags,revision FROM market_access_subjects'),
    query(`SELECT fingerprint,label,enabled,expires_at FROM market_keys UNION ALL
      SELECT fingerprint,'',1,NULL FROM market_plugin_key_grants WHERE fingerprint NOT IN (SELECT fingerprint FROM market_keys)`),
    query('SELECT id,name,enabled FROM market_organizations'),
    query('SELECT p.id,p.visibility,p.metadata,c.state,c.revision FROM market_plugins p JOIN market_catalog c ON c.id=p.id'),
    query('SELECT plugin_id,fingerprint FROM market_plugin_key_grants'),
    query('SELECT plugin_id,fingerprint FROM market_grants'),
    query('SELECT plugin_id,organization_id FROM market_org_grants'),
    query('SELECT plugin_id FROM market_org_policies'),
  ])
  const mixed = new Set(policies.map(p => p.plugin_id))
  const grants = [...direct, ...legacy.filter(g => !mixed.has(g.plugin_id))]
  const names = new Map(keys.map(k => [k.fingerprint, k]))
  for (const a of annotations) if (a.kind === 'key' && !names.has(a.id)) names.set(a.id, { fingerprint: a.id, enabled: 1 })
  const annotate = (kind, id, label, granted, extra = {}) => {
    const a = annotations.find(a => a.kind === kind && a.id === String(id))
    return { kind, id: String(id), label: a?.label || label, notes: a?.notes || '', tags: JSON.parse(a?.tags || '[]'),
      revision: a?.revision || 0, plugins: [...new Set(granted)], ...extra }
  }
  return {
    keys: [...names.values()].map(k => annotate('key', k.fingerprint, k.label || `Key ${k.fingerprint.slice(0, 10)}`,
      grants.filter(g => g.fingerprint === k.fingerprint).map(g => g.plugin_id), { enabled: k.enabled, expiresAt: k.expires_at })),
    organizations: organizations.map(o => annotate('organization', o.id, o.name,
      orgGrants.filter(g => g.organization_id === o.id).map(g => g.plugin_id), { name: o.name, enabled: o.enabled })),
    plugins: plugins.map(p => ({ id: p.id, name: JSON.parse(p.metadata).displayName || p.id,
      visibility: p.visibility, state: p.state, revision: p.revision, mixed: mixed.has(p.id) })),
  }
}

export async function saveAccessSubject(env, data) {
  if (!['key', 'organization'].includes(data.kind) || typeof data.label !== 'string' || !data.label.trim() || data.label.length > 120
    || typeof data.notes !== 'string' || data.notes.length > 1000 || !Array.isArray(data.tags) || data.tags.length > 20
    || !data.tags.every(t => typeof t === 'string' && t.trim() && t.length <= 40)
    || !Array.isArray(data.plugins) || data.plugins.length > 200 || !data.plugins.every(id => typeof id === 'string')
    || !Number.isSafeInteger(data.revision) || data.revision < 0 || !data.pluginRevisions || typeof data.pluginRevisions !== 'object') fail('名称、标签或授权字段无效')
  const snapshot = await accessSubjects(env)
  let id = String(data.id ?? ''), encrypted
  if (data.kind === 'key' && data.apiKey) {
    if (typeof data.apiKey !== 'string' || !/^sk-\S{1,509}$/u.test(data.apiKey)) fail('API Key 格式无效')
    const fp = await fingerprint(data.apiKey, env.MARKET_HMAC_SECRET)
    if (id && id !== fp) fail('不能替换已有 Key，请新建授权对象')
    id = fp
    encrypted = await sealKey(data.apiKey, 'subject', id, env)
  }
  const current = (data.kind === 'key' ? snapshot.keys : snapshot.organizations).find(s => s.id === id)
  if (!current && !(data.kind === 'key' && encrypted)) fail('授权对象不存在')
  if (data.apiKey && !data.id && current) fail('该 Key 已登记，请搜索后编辑，避免覆盖已有权限', 409)
  if ((current?.revision || 0) !== data.revision) fail('名录已变化，请刷新后重试', 409)
  const previous = new Set(current?.plugins || []), next = new Set(data.plugins)
  const changed = [...new Set([...previous, ...next])].filter(id => previous.has(id) !== next.has(id))
  const statements = []
  const p = (sql, ...args) => env.MARKET_DB.prepare(sql).bind(...args)
  for (const pluginId of changed) {
    const plugin = snapshot.plugins.find(p => p.id === pluginId)
    if (!plugin || plugin.state === 'deleted' || plugin.visibility !== 'restricted') fail('只能修改未删除的受限插件授权')
    if (data.pluginRevisions[pluginId] !== plugin.revision) fail('插件权限已变化，请刷新后重试', 409)
    if (data.kind === 'organization' && !plugin.mixed) fail('此插件使用旧权限模式，请先在插件页保存组织与 Key 权限后重试', 409)
    statements.push(revisionStatement(env, plugin, data.pluginRevisions[pluginId]))
    const table = data.kind === 'organization' ? 'market_org_grants' : plugin.mixed ? 'market_plugin_key_grants' : 'market_grants'
    const column = data.kind === 'organization' ? 'organization_id' : 'fingerprint'
    const subjectId = data.kind === 'organization' ? Number(id) : id
    statements.push(p(`DELETE FROM ${table} WHERE plugin_id=? AND ${column}=?`, pluginId, subjectId))
    if (next.has(pluginId)) statements.push(p(`INSERT INTO ${table}(plugin_id,${column}) VALUES(?,?)`, pluginId, subjectId))
    else if (data.kind === 'key') statements.push(p('DELETE FROM market_plugin_key_values WHERE plugin_id=? AND fingerprint=?', pluginId, id))
    if (next.has(pluginId) && data.kind === 'key' && data.apiKey && plugin.mixed) {
      statements.push(p('INSERT INTO market_plugin_key_values(plugin_id,fingerprint,encrypted_value) VALUES(?,?,?) ON CONFLICT(plugin_id,fingerprint) DO UPDATE SET encrypted_value=excluded.encrypted_value', pluginId, id, await sealKey(data.apiKey, pluginId, id, env)))
    }
  }
  // Existing legacy enabled/expiry settings must not be silently reset.
  if (data.kind === 'key') statements.unshift(p('INSERT INTO market_keys(fingerprint,label,enabled,expires_at) VALUES(?,?,1,NULL) ON CONFLICT(fingerprint) DO NOTHING', id, data.label.trim()))
  const fields = [data.label.trim(), data.notes.trim(), JSON.stringify([...new Set(data.tags.map(t => t.trim()))])]
  if (data.revision === 0) statements.push(p('INSERT INTO market_access_subjects(kind,id,label,notes,tags,encrypted_value) VALUES(?,?,?,?,?,?)', data.kind, id, ...fields, encrypted ?? null))
  else statements.push(p('UPDATE market_access_subjects SET label=?,notes=?,tags=?,encrypted_value=COALESCE(?,encrypted_value),revision=? WHERE kind=? AND id=?', ...fields, encrypted ?? null, data.revision + 1, data.kind, id))
  statements.push(...auditStatements(env, 'subject.access.updated', data.kind === 'key' ? 'key' : id, { kind: data.kind, added: changed.filter(id => next.has(id)).length, removed: changed.filter(id => !next.has(id)).length }))
  try { await env.MARKET_DB.batch(statements) }
  catch (error) { if (/revision conflict|UNIQUE constraint/u.test(error.message)) fail('授权已被其他管理员修改，请刷新后重试', 409); throw error }
  return { ok: true, id }
}
