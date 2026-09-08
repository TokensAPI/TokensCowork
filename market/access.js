import { organizationAccess, organizationState, validOrganizationId, syncOrganizations } from './organizations.js'
const enc = new TextEncoder()
export const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'vary': 'Authorization' },
})
function bearer(request) {
  return /^Bearer ([^\s]{1,512})$/u.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
}
export async function fingerprint(key, secret) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(key))), b => b.toString(16).padStart(2, '0')).join('')
}
async function admin(request, env) {
  const token = bearer(request)
  return token && env.MARKET_ADMIN_TOKEN && env.MARKET_HMAC_SECRET
    && await fingerprint(token, env.MARKET_HMAC_SECRET) === await fingerprint(env.MARKET_ADMIN_TOKEN, env.MARKET_HMAC_SECRET)
}
function text(value, max = 200) { return typeof value === 'string' && value.length <= max && value.trim().length > 0 }
const idOK = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(value)
async function body(request) {
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
  return JSON.parse(new TextDecoder().decode(bytes))
}
export async function allowed(request, env, pluginId) {
  if (await env.MARKET_DB.prepare('SELECT 1 FROM market_org_policies WHERE plugin_id=?').bind(pluginId).first()) {
    return (await organizationAccess(request, env)).has(pluginId)
  }
  const key = bearer(request)
  if (!key || !env.MARKET_HMAC_SECRET) return false
  const fp = await fingerprint(key, env.MARKET_HMAC_SECRET)
  return !!await env.MARKET_DB.prepare(`SELECT 1 FROM market_keys k JOIN market_grants g ON g.fingerprint=k.fingerprint
    WHERE k.fingerprint=? AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>?) AND g.plugin_id=?`)
    .bind(fp, Date.now(), pluginId).first()
}
export async function filterRoster(request, env, roster) {
  if (!env.MARKET_DB) return roster
  const { results } = await env.MARKET_DB.prepare('SELECT * FROM market_plugins').all()
  const merged = new Map(roster.items.map(item => [item.id, item]))
  const { results: policies } = await env.MARKET_DB.prepare('SELECT plugin_id FROM market_org_policies').all()
  const orgPolicies = new Set(policies.map(p => p.plugin_id))
  const needsOrg = results.some(row => row.visibility !== 'public' && orgPolicies.has(row.id))
  const orgAllowed = needsOrg ? await organizationAccess(request, env) : new Set()
  for (const row of results) {
    merged.delete(row.id)
    if (row.visibility === 'public' || (orgPolicies.has(row.id) ? orgAllowed.has(row.id) : await allowed(request, env, row.id))) {
      merged.set(row.id, JSON.parse(row.metadata))
    }
  }
  return { ...roster, items: [...merged.values()] }
}
export async function accessRoute(request, env) {
  const url = new URL(request.url)
  const isAdmin = url.pathname.startsWith('/api/admin/')
  const download = /^\/downloads\/([a-z0-9-]+)$/u.exec(url.pathname)
  if (!isAdmin && !download) return null
  if (!env.MARKET_DB || !env.MARKET_HMAC_SECRET) return reply({ error: '授权服务未配置' }, 503)
  try {
    if (download) {
      if (request.method !== 'GET') return reply({ error: 'method not allowed' }, 405)
      const row = await env.MARKET_DB.prepare('SELECT * FROM market_plugins WHERE id=?').bind(download[1]).first()
      if (!row || (row.visibility !== 'public' && !await allowed(request, env, row.id))) return reply({ error: '没有下载权限' }, 403)
      if (!row.object_key || !env.MARKET_PACKAGES) return reply({ error: '未配置私有安装包' }, 404)
      const object = await env.MARKET_PACKAGES.get(row.object_key)
      if (!object) return reply({ error: '安装包不存在' }, 404)
      return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'vary': 'Authorization', 'content-disposition': `attachment; filename="${row.id}.tgz"` } })
    }
    if (!await admin(request, env)) return reply({ error: '管理员凭证无效' }, 401)
    if (request.method !== 'GET' && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return reply({ error: '跨站请求被拒绝' }, 403)
    if (request.method === 'GET' && url.pathname === '/api/admin/access') {
      const [keys, grants, plugins] = await Promise.all([
        env.MARKET_DB.prepare('SELECT fingerprint,label,enabled,expires_at FROM market_keys ORDER BY label').all(),
        env.MARKET_DB.prepare('SELECT fingerprint,plugin_id FROM market_grants').all(),
        env.MARKET_DB.prepare('SELECT * FROM market_plugins ORDER BY id').all(),
      ])
      return reply({ keys: keys.results, grants: grants.results, plugins: plugins.results.map(p => ({ ...p, metadata: JSON.parse(p.metadata) })), ...await organizationState(env) })
    }
    if (request.method !== 'PUT') return reply({ error: 'method not allowed' }, 405)
    let data
    try { data = await body(request) } catch { return reply({ error: '请求格式无效或超过 16 KB' }, 400) }
    if (url.pathname === '/api/admin/organizations/sync') return reply({ count:await syncOrganizations(env) })
    if (url.pathname === '/api/admin/organizations') {
      if (!validOrganizationId(data.id) || !text(data.name) || typeof data.enabled !== 'boolean') return reply({ error: '请填写有效的组织 ID、名称和启用状态' }, 400)
      await env.MARKET_DB.prepare(`INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled`).bind(data.id, data.name.trim(), Number(data.enabled)).run()
      return reply({ ok: true })
    }
    if (url.pathname === '/api/admin/keys') {
      if (!text(data.label) || typeof data.enabled !== 'boolean' || !Array.isArray(data.plugins) || data.plugins.length > 200 || !data.plugins.every(idOK)
        || (data.expiresAt != null && (!Number.isSafeInteger(data.expiresAt) || data.expiresAt <= 0))) return reply({ error: '授权字段无效' }, 400)
      let fp = data.fingerprint
      if (data.apiKey !== undefined) {
        if (!text(data.apiKey, 512) || !/^sk-\S+$/u.test(data.apiKey)) return reply({ error: 'API Key 格式无效' }, 400)
        fp = await fingerprint(data.apiKey, env.MARKET_HMAC_SECRET)
      } else if (!/^[a-f0-9]{64}$/u.test(fp ?? '') || !await env.MARKET_DB.prepare('SELECT 1 FROM market_keys WHERE fingerprint=?').bind(fp).first()) {
        return reply({ error: '请选择现有授权或输入 API Key' }, 400)
      }
      await env.MARKET_DB.batch([
        env.MARKET_DB.prepare(`INSERT INTO market_keys(fingerprint,label,enabled,expires_at) VALUES(?,?,?,?)
          ON CONFLICT(fingerprint) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,expires_at=excluded.expires_at`).bind(fp, data.label, Number(data.enabled), data.expiresAt ?? null),
        env.MARKET_DB.prepare('DELETE FROM market_grants WHERE fingerprint=?').bind(fp),
        ...[...new Set(data.plugins)].map(id => env.MARKET_DB.prepare('INSERT INTO market_grants(fingerprint,plugin_id) VALUES(?,?)').bind(fp, id)),
      ])
      return reply({ fingerprint: fp })
    }
    if (['/api/admin/plugins', '/api/admin/plugin-keys', '/api/admin/plugin-organizations'].includes(url.pathname)) {
      const orgMode = url.pathname === '/api/admin/plugin-organizations'
      if (!orgMode && await env.MARKET_DB.prepare('SELECT 1 FROM market_org_policies WHERE plugin_id=?').bind(data.id ?? '').first()) {
        return reply({ error: '此插件已按组织管理，请使用组织配置入口' }, 409)
      }
      if (orgMode) {
        if (!Array.isArray(data.organizationIds) || data.organizationIds.length > 100 || !data.organizationIds.every(validOrganizationId)) return reply({ error: '组织列表无效，最多 100 个组织' }, 400)
        data.organizationIds = [...new Set(data.organizationIds)]
        for (const id of data.organizationIds) {
          if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_organizations WHERE id=?').bind(id).first()) return reply({ error: '请先登记所选组织' }, 400)
        }
        const previous = await env.MARKET_DB.prepare('SELECT visibility FROM market_plugins WHERE id=?').bind(data.id ?? '').first()
        if (previous?.visibility === 'restricted' && !data.organizationIds.length && data.confirmPublic !== true) return reply({ error: '此操作将公开插件，请明确确认' }, 409)
        data.visibility = data.organizationIds.length ? 'restricted' : 'public'
      }
      const simple = url.pathname === '/api/admin/plugin-keys'
      let fingerprints = [], newKeys = []
      if (simple) {
        if (!Array.isArray(data.apiKeys) || !Array.isArray(data.keepFingerprints) || data.apiKeys.length + data.keepFingerprints.length > 100
          || !data.apiKeys.every(k => text(k, 512) && /^sk-\S+$/u.test(k))
          || !data.keepFingerprints.every(k => /^[a-f0-9]{64}$/u.test(k))) return reply({ error: '请每行填写一个有效 API Key，最多 100 个' }, 400)
        for (const fp of data.keepFingerprints) {
          if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_grants WHERE fingerprint=? AND plugin_id=?').bind(fp, data.id).first()) return reply({ error: '原授权已变更，请刷新后重试' }, 400)
        }
        newKeys = await Promise.all(data.apiKeys.map(k => fingerprint(k, env.MARKET_HMAC_SECRET)))
        fingerprints = [...new Set([...data.keepFingerprints, ...newKeys])]
        data.visibility = fingerprints.length ? 'restricted' : 'public'
      }
      const m = data.metadata
      if (!idOK(data.id) || !['public', 'restricted'].includes(data.visibility) || !m || m.id !== data.id
        || !text(m.package) || !text(m.displayName) || !text(m.summary, 2000) || !/^\d+\.\d+\.\d+$/u.test(m.version ?? '')
        || typeof m.npm !== 'boolean') return reply({ error: '插件字段无效' }, 400)
      try { if (new URL(m.repository).protocol !== 'https:') throw new Error() } catch { return reply({ error: '仓库地址必须为 HTTPS' }, 400) }
      if (data.objectKey != null && !/^[a-zA-Z0-9/_.-]{1,240}$/u.test(data.objectKey)) return reply({ error: '安装包对象名无效' }, 400)
      const metadata = { id: m.id, package: m.package, displayName: m.displayName, summary: m.summary, repository: m.repository, version: m.version, npm: m.npm }
      const savePlugin = env.MARKET_DB.prepare(`INSERT INTO market_plugins(id,visibility,metadata,object_key) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET visibility=excluded.visibility,metadata=excluded.metadata,object_key=excluded.object_key`)
        .bind(data.id, data.visibility, JSON.stringify(metadata), data.objectKey || null)
      if (orgMode) {
        await env.MARKET_DB.batch([
          savePlugin,
          env.MARKET_DB.prepare('INSERT INTO market_org_policies(plugin_id) VALUES(?) ON CONFLICT(plugin_id) DO NOTHING').bind(data.id),
          env.MARKET_DB.prepare('DELETE FROM market_org_grants WHERE plugin_id=?').bind(data.id),
          ...data.organizationIds.map(id => env.MARKET_DB.prepare('INSERT INTO market_org_grants(plugin_id,organization_id) VALUES(?,?)').bind(data.id, id)),
        ])
      } else if (simple) {
        await env.MARKET_DB.batch([
          savePlugin,
          ...[...new Set(newKeys)].map(fp => env.MARKET_DB.prepare(`INSERT INTO market_keys(fingerprint,label,enabled,expires_at) VALUES(?,?,1,NULL) ON CONFLICT(fingerprint) DO NOTHING`).bind(fp, 'Key '+fp.slice(0, 8))),
          env.MARKET_DB.prepare('DELETE FROM market_grants WHERE plugin_id=?').bind(data.id),
          ...fingerprints.map(fp => env.MARKET_DB.prepare('INSERT INTO market_grants(fingerprint,plugin_id) VALUES(?,?)').bind(fp, data.id)),
        ])
      } else await savePlugin.run()
      return reply({ ok: true })
    }
    return reply({ error: 'not found' }, 404)
  } catch { return reply({ error: '授权服务暂时不可用' }, 503) }
}
