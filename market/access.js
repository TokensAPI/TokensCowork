import { organizationAccess, organizationState, validOrganizationId, syncOrganizations } from './organizations.js'
import { sealKey, openKey } from './key-vault.js'
import { validSession, createSession, endSession } from './admin-session.js'
const enc = new TextEncoder()
export const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'vary': 'Authorization, Cookie' },
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
    if ((await directKeyAccess(request,env)).has(pluginId)) return true
    if (!await env.MARKET_DB.prepare('SELECT 1 FROM market_org_grants WHERE plugin_id=?').bind(pluginId).first()) return false
    return (await organizationAccess(request, env)).has(pluginId)
  }
  const key = bearer(request)
  if (!key || !env.MARKET_HMAC_SECRET) return false
  const fp = await fingerprint(key, env.MARKET_HMAC_SECRET)
  return !!await env.MARKET_DB.prepare(`SELECT 1 FROM market_keys k JOIN market_grants g ON g.fingerprint=k.fingerprint
    WHERE k.fingerprint=? AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>?) AND g.plugin_id=?`)
    .bind(fp, Date.now(), pluginId).first()
}
async function directKeyAccess(request,env) {
  const key=bearer(request)
  if(!key) return new Set()
  const fp=await fingerprint(key,env.MARKET_HMAC_SECRET)
  const {results}=await env.MARKET_DB.prepare('SELECT plugin_id FROM market_plugin_key_grants WHERE fingerprint=?').bind(fp).all()
  return new Set(results.map(row=>row.plugin_id))
}
export async function filterRoster(request, env, roster) {
  if (!env.MARKET_DB) return roster
  const { results } = await env.MARKET_DB.prepare('SELECT * FROM market_plugins').all()
  const merged = new Map(roster.items.map(item => [item.id, item]))
  const { results: policies } = await env.MARKET_DB.prepare('SELECT plugin_id FROM market_org_policies').all()
  const orgPolicies = new Set(policies.map(p => p.plugin_id))
  const directAllowed=await directKeyAccess(request,env)
  const {results: orgGrants}=await env.MARKET_DB.prepare('SELECT DISTINCT plugin_id FROM market_org_grants').all()
  const orgIds=new Set(orgGrants.map(g=>g.plugin_id))
  const needsOrg = results.some(row => row.visibility !== 'public' && orgIds.has(row.id) && !directAllowed.has(row.id))
  let orgAllowed=new Set()
  if(needsOrg) {
    try {orgAllowed=await organizationAccess(request,env)}
    catch(error) {if(!directAllowed.size) throw error} // Explicit Key grants remain usable independently.
  }
  for (const row of results) {
    merged.delete(row.id)
    if (row.visibility === 'public' || (orgPolicies.has(row.id) ? directAllowed.has(row.id) || orgAllowed.has(row.id) : await allowed(request, env, row.id))) {
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
    if(url.pathname==='/api/admin/login'){
      if(request.method!=='PUT')return reply({error:'method not allowed'},405)
      if(request.headers.get('origin')!==url.origin)return reply({error:'跨站请求被拒绝'},403)
      let data
      try{data=await body(request)}catch{return reply({error:'请求格式无效'},400)}
      if(!text(data.credential,512)||!env.MARKET_ADMIN_TOKEN||await fingerprint(data.credential,env.MARKET_HMAC_SECRET)!==await fingerprint(env.MARKET_ADMIN_TOKEN,env.MARKET_HMAC_SECRET))return reply({error:'管理凭证无效'},401)
      const response=reply({ok:true})
      response.headers.set('set-cookie',await createSession(request,env))
      return response
    }
    if(url.pathname==='/api/admin/logout'){
      if(request.method!=='PUT')return reply({error:'method not allowed'},405)
      if(request.headers.get('origin')!==url.origin)return reply({error:'跨站请求被拒绝'},403)
      const response=reply({ok:true})
      response.headers.set('set-cookie',await endSession(request,env))
      return response
    }
    const bearerAdmin=await admin(request,env)
    if (!bearerAdmin && !await validSession(request,env)) return reply({ error: '管理员凭证无效' }, 401)
    if(!bearerAdmin && request.method!=='GET' && request.headers.get('origin')!==url.origin)return reply({error:'跨站请求被拒绝'},403)
    if(request.method==='GET' && url.pathname==='/api/admin/plugin-key-values'){
      const id=url.searchParams.get('id')
      if(!idOK(id))return reply({error:'插件 ID 无效'},400)
      const {results}=await env.MARKET_DB.prepare('SELECT v.fingerprint,v.encrypted_value FROM market_plugin_key_values v JOIN market_plugin_key_grants g ON g.plugin_id=v.plugin_id AND g.fingerprint=v.fingerprint WHERE v.plugin_id=?').bind(id).all()
      return reply({keys:await Promise.all(results.map(async row=>({fingerprint:row.fingerprint,apiKey:await openKey(row.encrypted_value,id,row.fingerprint,env)})))})
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/roster') {
      const response = await env.ASSETS.fetch(new URL('/roster.json', request.url).toString())
      if (!response.ok) throw new Error('roster unavailable')
      return reply(await response.json())
    }
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
    if (['/api/admin/plugins', '/api/admin/plugin-keys', '/api/admin/plugin-organizations','/api/admin/plugin-access'].includes(url.pathname)) {
      // Classification is maintained in the release roster, never trusted from request metadata.
      const rosterResponse=await env.ASSETS.fetch(new URL('/roster.json',request.url).toString())
      if(!rosterResponse.ok) throw new Error('roster unavailable')
      const roster=await rosterResponse.json()
      if(!Array.isArray(roster.items)) throw new Error('invalid roster')
      if(roster.items.some(p=>p.id===data.id && p.category==='builtin')) {
        return reply({error:'内置组件随应用更新，不支持配置市场权限'},409)
      }
      const mixedMode=url.pathname==='/api/admin/plugin-access'
      const orgMode = url.pathname === '/api/admin/plugin-organizations' || mixedMode
      let directFingerprints=[],addedFingerprints=[],encryptedKeys=[]
      if(mixedMode) {
        if(!Array.isArray(data.apiKeys) || !Array.isArray(data.keepFingerprints) || data.apiKeys.length+data.keepFingerprints.length>100
          || !data.apiKeys.every(k=>text(k,512) && /^sk-\S+$/u.test(k)) || !data.keepFingerprints.every(fp=>/^[a-f0-9]{64}$/u.test(fp))) return reply({error:'API Key 格式无效，每行一个，最多 100 个'},400)
        const migrated=await env.MARKET_DB.prepare('SELECT 1 FROM market_org_policies WHERE plugin_id=?').bind(data.id??'').first()
        for(const fp of data.keepFingerprints) {
          const existing=await env.MARKET_DB.prepare('SELECT 1 FROM market_plugin_key_grants WHERE plugin_id=? AND fingerprint=?').bind(data.id,fp).first()
          const legacy=!migrated && await env.MARKET_DB.prepare(`SELECT 1 FROM market_grants g JOIN market_keys k ON g.fingerprint=k.fingerprint WHERE g.plugin_id=? AND g.fingerprint=? AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>?)`).bind(data.id,fp,Date.now()).first()
          if(!existing && !legacy) return reply({error:'已保存的 Key 已变化，请刷新后重试'},400)
        }
        addedFingerprints=await Promise.all(data.apiKeys.map(k=>fingerprint(k,env.MARKET_HMAC_SECRET)))
        directFingerprints=[...new Set([...data.keepFingerprints,...addedFingerprints])]
        encryptedKeys=await Promise.all([...new Map(data.apiKeys.map((key,i)=>[addedFingerprints[i],key]))].map(async([fp,key])=>({fp,value:await sealKey(key,data.id,fp,env)})))
      } else if(orgMode) {
        const {results}=await env.MARKET_DB.prepare('SELECT fingerprint FROM market_plugin_key_grants WHERE plugin_id=?').bind(data.id??'').all()
        directFingerprints=results.map(r=>r.fingerprint)
      }
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
        if (previous?.visibility === 'restricted' && !data.organizationIds.length && !directFingerprints.length && data.confirmPublic !== true) return reply({ error: '此操作将公开插件，请明确确认' }, 409)
        data.visibility = data.organizationIds.length || directFingerprints.length ? 'restricted' : 'public'
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
          ...(mixedMode ? [env.MARKET_DB.prepare('DELETE FROM market_plugin_key_grants WHERE plugin_id=?').bind(data.id),
            ...directFingerprints.map(fp=>env.MARKET_DB.prepare('INSERT INTO market_plugin_key_grants(plugin_id,fingerprint) VALUES(?,?)').bind(data.id,fp))]:[]),
          ...(mixedMode ? [
            env.MARKET_DB.prepare('DELETE FROM market_plugin_key_values WHERE plugin_id=? AND fingerprint NOT IN (SELECT fingerprint FROM market_plugin_key_grants WHERE plugin_id=?)').bind(data.id,data.id),
            ...encryptedKeys.map(({fp,value})=>env.MARKET_DB.prepare('INSERT INTO market_plugin_key_values(plugin_id,fingerprint,encrypted_value) VALUES(?,?,?) ON CONFLICT(plugin_id,fingerprint) DO UPDATE SET encrypted_value=excluded.encrypted_value').bind(data.id,fp,value))
          ]:[]),
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
