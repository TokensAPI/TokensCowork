import { organizationState, validOrganizationId, syncOrganizations } from '../services/organization-service.js'
import { sealKey, openKey } from '../security/key-vault.js'
import { validSession, createSession, endSession } from '../security/admin-session.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { bearer, text, idOK, body } from '../http/request.js'
import { reply } from '../http/response.js'
import { allowed } from '../services/plugin-access-service.js'
import { adminLoginWait, recordAdminLoginFailure, clearAdminLoginFailures } from '../security/admin-login-limit.js'
import { adminOperations } from '../services/admin-operations-service.js'
import { auditStatements } from '../services/admin-audit-service.js'
import { accessPreview } from '../services/access-preview-service.js'
import { catalogRoster, catalogMutation, catalogEntry, revisionStatement } from '../services/catalog-service.js'
import { npmPackage } from '../integrations/npm-registry.js'
import { resolveNpmVersions } from '../services/npm-version-service.js'
function loginLimited(wait) {
  const response = reply({ error: '尝试次数过多，请稍后再试', retryAfter: wait }, 429)
  response.headers.set('retry-after', String(wait))
  return response
}
async function admin(request, env) {
  const token = bearer(request)
  return token && env.MARKET_ADMIN_TOKEN && env.MARKET_HMAC_SECRET
    && await fingerprint(token, env.MARKET_HMAC_SECRET) === await fingerprint(env.MARKET_ADMIN_TOKEN, env.MARKET_HMAC_SECRET)
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
      const row = await env.MARKET_DB.prepare("SELECT p.* FROM market_plugins p JOIN market_catalog c ON c.id=p.id WHERE p.id=? AND c.state='published'").bind(download[1]).first()
      if (!row || (row.visibility !== 'public' && !await allowed(request, env, row.id))) return reply({ error: '没有下载权限' }, 403)
      if (!row.object_key || !env.MARKET_PACKAGES) return reply({ error: '未配置私有安装包' }, 404)
      const object = await env.MARKET_PACKAGES.get(row.object_key)
      if (!object) return reply({ error: '安装包不存在' }, 404)
      return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'vary': 'Authorization', 'content-disposition': `attachment; filename="${row.id}.tgz"` } })
    }
    if(url.pathname==='/api/admin/login'){
      if(request.method!=='PUT')return reply({error:'method not allowed'},405)
      if(request.headers.get('origin')!==url.origin)return reply({error:'跨站请求被拒绝'},403)
      const wait = await adminLoginWait(request, env)
      if (wait) return loginLimited(wait)
      let data
      try{data=await body(request)}catch{return reply({error:'请求格式无效'},400)}
      if(!text(data?.credential,512)||!env.MARKET_ADMIN_TOKEN||await fingerprint(data.credential,env.MARKET_HMAC_SECRET)!==await fingerprint(env.MARKET_ADMIN_TOKEN,env.MARKET_HMAC_SECRET)) {
        const blocked = await recordAdminLoginFailure(request, env)
        return blocked ? loginLimited(blocked) : reply({error:'管理凭证无效'},401)
      }
      await clearAdminLoginFailures(request, env)
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
    const sessionAdmin = await validSession(request, env)
    const bearerToken = bearer(request)
    if (!sessionAdmin && bearerToken) {
      const wait = await adminLoginWait(request, env)
      if (wait) return loginLimited(wait)
    }
    const bearerAdmin=await admin(request,env)
    if (!bearerAdmin && !sessionAdmin) {
      const wait = bearerToken ? await recordAdminLoginFailure(request, env) : 0
      return wait ? loginLimited(wait) : reply({ error: '管理员凭证无效' }, 401)
    }
    if (bearerAdmin && !sessionAdmin) await clearAdminLoginFailures(request, env)
    if(!bearerAdmin && request.method!=='GET' && request.headers.get('origin')!==url.origin)return reply({error:'跨站请求被拒绝'},403)
    if(request.method==='GET' && url.pathname==='/api/admin/plugin-key-values'){
      const id=url.searchParams.get('id')
      if(!idOK(id))return reply({error:'插件 ID 无效'},400)
      const {results}=await env.MARKET_DB.prepare('SELECT v.fingerprint,v.encrypted_value FROM market_plugin_key_values v JOIN market_plugin_key_grants g ON g.plugin_id=v.plugin_id AND g.fingerprint=v.fingerprint WHERE v.plugin_id=?').bind(id).all()
      return reply({keys:await Promise.all(results.map(async row=>({fingerprint:row.fingerprint,apiKey:await openKey(row.encrypted_value,id,row.fingerprint,env)})))})
    }
    if (request.method === 'GET' && ['/api/admin/roster','/api/admin/catalog'].includes(url.pathname)) {
      const roster = await catalogRoster(env,true)
      return reply({...roster, items: await resolveNpmVersions(roster.items)})
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/npm-package') return reply(await npmPackage(url.searchParams.get('package'),url.searchParams.get('version') || 'latest'))
    if (request.method !== 'GET' && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return reply({ error: '跨站请求被拒绝' }, 403)
    if (request.method === 'GET' && url.pathname === '/api/admin/access') {
      const [keys, grants, plugins] = await Promise.all([
        env.MARKET_DB.prepare('SELECT fingerprint,label,enabled,expires_at FROM market_keys ORDER BY label').all(),
        env.MARKET_DB.prepare('SELECT fingerprint,plugin_id FROM market_grants').all(),
        env.MARKET_DB.prepare('SELECT * FROM market_plugins ORDER BY id').all(),
      ])
      return reply({ keys: keys.results, grants: grants.results, plugins: plugins.results.map(p => ({ ...p, metadata: JSON.parse(p.metadata) })), ...await organizationState(env) })
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/operations') return reply(await adminOperations(env))
    if (request.method !== 'PUT') return reply({ error: 'method not allowed' }, 405)
    let data
    try { data = await body(request) } catch { return reply({ error: '请求格式无效或超过 16 KB' }, 400) }
    if (url.pathname === '/api/admin/catalog') return reply(await catalogMutation(request,env,data))
    if (url.pathname === '/api/admin/access-preview') {
      if (!text(data.apiKey, 512) || !/^sk-\S+$/u.test(data.apiKey)) return reply({ error: '请输入有效的 API Key' }, 400)
      return reply(await accessPreview(request, env, data.apiKey))
    }
    if (url.pathname === '/api/admin/organizations/sync') {
      try{return reply({count:await syncOrganizations(env)})}
      catch(error){
        const code=error?.providerCode
        if(typeof code==='string' && /^(HTTP_[0-9]{3}|TIMEOUT|INVALID_JSON|TRANSPORT_TYPE_ERROR|FETCH_BINDING|CACHE_OPTION|REDIRECT|HEADER|INVALID_RESPONSE)$/u.test(code))return reply({error:'组织服务请求失败（'+code+'），请核对上游连接与配置'},503)
        throw error
      }
    }
    if (url.pathname === '/api/admin/organizations') {
      if (!validOrganizationId(data.id) || !text(data.name) || typeof data.enabled !== 'boolean') return reply({ error: '请填写有效的组织 ID、名称和启用状态' }, 400)
      await env.MARKET_DB.batch([
        env.MARKET_DB.prepare(`INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled`).bind(data.id, data.name.trim(), Number(data.enabled)),
        ...auditStatements(env, 'organization.updated', data.id, { enabled: data.enabled }),
      ])
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
      if (!idOK(data.id)) return reply({error:'插件 ID 无效'},400)
      const entry = await catalogEntry(env,data.id ?? '')
      if(!entry) return reply({error:'请先通过新建插件创建草稿；内置组件不支持市场权限配置'},409)
      if(entry.state === 'deleted')return reply({error:'请先从回收站恢复插件'},409)
      const revision = revisionStatement(env,entry,data.revision ?? entry.revision)
      const mixedMode=url.pathname==='/api/admin/plugin-access'
      const orgMode = url.pathname === '/api/admin/plugin-organizations' || mixedMode
      let directFingerprints=[],addedFingerprints=[],encryptedKeys=[]
      if(mixedMode) {
        if(!Array.isArray(data.apiKeys) || !Array.isArray(data.keepFingerprints) || data.apiKeys.length>100 || data.keepFingerprints.length>100
          || !data.apiKeys.every(k=>text(k,512) && /^sk-\S+$/u.test(k)) || !data.keepFingerprints.every(fp=>/^[a-f0-9]{64}$/u.test(fp))) return reply({error:'API Key 格式无效，每行一个，最多 100 个'},400)
        const migrated=await env.MARKET_DB.prepare('SELECT 1 FROM market_org_policies WHERE plugin_id=?').bind(data.id??'').first()
        for(const fp of data.keepFingerprints) {
          const existing=await env.MARKET_DB.prepare('SELECT 1 FROM market_plugin_key_grants WHERE plugin_id=? AND fingerprint=?').bind(data.id,fp).first()
          const legacy=!migrated && await env.MARKET_DB.prepare(`SELECT 1 FROM market_grants g JOIN market_keys k ON g.fingerprint=k.fingerprint WHERE g.plugin_id=? AND g.fingerprint=? AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>?)`).bind(data.id,fp,Date.now()).first()
          if(!existing && !legacy) return reply({error:'已保存的 Key 已变化，请刷新后重试'},400)
        }
        addedFingerprints=await Promise.all(data.apiKeys.map(k=>fingerprint(k,env.MARKET_HMAC_SECRET)))
        directFingerprints=[...new Set([...data.keepFingerprints,...addedFingerprints])]
        if(directFingerprints.length>100) return reply({error:'每个插件最多授权 100 个不同 API Key'},400)
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
      if (!['public', 'restricted'].includes(data.visibility)) return reply({ error: '访问范围无效' }, 400)
      if (data.objectKey != null && (typeof data.objectKey !== 'string' || data.objectKey !== data.objectKey.trim() || !/^[a-zA-Z0-9/_.-]{1,240}$/u.test(data.objectKey))) return reply({ error: '安装包对象名无效' }, 400)
      // ACL writes never validate or rewrite client-provided plugin metadata.
      // Missing objectKey means unchanged; explicit null clears it for legacy clients.
      const objectKey = Object.hasOwn(data, 'objectKey') ? data.objectKey : entry.object_key
      const savePlugin = env.MARKET_DB.prepare('UPDATE market_plugins SET visibility=?,object_key=? WHERE id=?')
        .bind(data.visibility, objectKey ?? null, data.id)
      if (orgMode) {
        await env.MARKET_DB.batch([
          revision,
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
          ...auditStatements(env, 'plugin.access.updated', data.id, { visibility: data.visibility, organizationCount: data.organizationIds.length, keyCount: directFingerprints.length }),
        ])
      } else if (simple) {
        await env.MARKET_DB.batch([
          revision,
          savePlugin,
          ...[...new Set(newKeys)].map(fp => env.MARKET_DB.prepare(`INSERT INTO market_keys(fingerprint,label,enabled,expires_at) VALUES(?,?,1,NULL) ON CONFLICT(fingerprint) DO NOTHING`).bind(fp, 'Key '+fp.slice(0, 8))),
          env.MARKET_DB.prepare('DELETE FROM market_grants WHERE plugin_id=?').bind(data.id),
          ...fingerprints.map(fp => env.MARKET_DB.prepare('INSERT INTO market_grants(fingerprint,plugin_id) VALUES(?,?)').bind(fp, data.id)),
        ])
      } else await env.MARKET_DB.batch([revision,savePlugin])
      return reply({ ok: true })
    }
    return reply({ error: 'not found' }, 404)
  } catch(error) {
    if (error.status && [400,404,409,502,503].includes(error.status))return reply({error:error.message},error.status)
    if (/catalog revision conflict|UNIQUE constraint failed: market_(catalog|plugins)/u.test(error.message ?? ''))return reply({error:'插件已被其他操作修改或 ID 已存在，请刷新后重试'},409)
    return reply({ error: '授权服务暂时不可用' }, 503)
  }
}
