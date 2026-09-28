import { reply } from '../http/response.js'
import { body, bearer } from '../http/request.js'
import { resolvePrincipal, isPlatform, login, logout } from '../services/auth.js'
import { adminLoginWait, recordAdminLoginFailure, clearAdminLoginFailures } from '../security/admin-login-limit.js'
import { pluginRows, pluginRow, pluginView, pluginGrants, noGrants, createPlugin, changePlugin, setPluginAccess, subjectGrants, setSubjectGrants, productComponents, publisher, invalid } from '../services/plugins.js'
import { listOrganizations, getOrganization, saveOrganization, syncOrganizations, organizationProviderReady, organizationSessionReady, searchUsers } from '../services/organizations.js'
import { organizationPlugins, setOrganizationPlugin } from '../services/access.js'
import { listKeys, getKey, addKey, updateKey, deleteKey } from '../services/keys.js'
import { listUsers, getUser, saveUser, deleteUser } from '../services/users.js'
import { auditLog, environment } from '../services/audit.js'
import { npmPackage } from '../integrations/npm-registry.js'
import { isPrivateNpmReference, privateNpmPackage } from '../private-registry/package.mjs'
import { resolveNpmVersions } from '../services/npm-version-service.js'
import { selectCatalogSources } from '../services/catalog-source-service.js'

// The market's one management API, /api/v1. The console and TokensAPI's backend call the same
// routes: a Bearer admin token is the platform administrator; a console session cookie is the
// platform or an organization administrator. Cookie writes must come from this origin, which with
// SameSite=Strict leaves no cross-site request surface.
const LOGIN_SCOPE = 'market-admin-login'
const API_SCOPE = 'market-service-api'
const LIFECYCLE = ['publish', 'archive', 'trash', 'restore', 'purge']
const SYNC_CODES = /^(HTTP_[0-9]{3}|TIMEOUT|INVALID_JSON|TRANSPORT_TYPE_ERROR|FETCH_BINDING|CACHE_OPTION|REDIRECT|HEADER|INVALID_RESPONSE)$/u

const limited = wait => reply({ error: '尝试次数过多，请稍后再试', retryAfter: wait }, 429, { 'retry-after': String(wait) })
const sameOrigin = (request, url) => request.headers.get('origin') === url.origin
async function payload(request) {
  if (!request.body) return {}
  try { return await body(request) } catch { throw invalid('请求格式无效或超过 16 KB') }
}
const onlyPlatform = principal => { if (!isPlatform(principal)) throw invalid('只有平台管理员可以执行此操作', 403) }
// An organization administrator reaches its own organization and nothing else.
function organizationId(principal, segment) {
  const id = /^[1-9][0-9]{0,15}$/u.test(segment ?? '') ? Number(segment) : 0
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid('组织无效')
  if (!isPlatform(principal) && principal.organizationId !== id) throw invalid('无权管理该组织', 403)
  return id
}
const userId = segment => /^[1-9][0-9]{0,15}$/u.test(segment ?? '') && Number.isSafeInteger(Number(segment)) ? Number(segment) : 0
// What one organization, Key or user holds, read or replaced as a whole.
async function grants(request, env, method, kind, subject, actor) {
  methods(method, ['GET', 'PUT'])
  return method === 'GET' ? subjectGrants(env, kind, subject) : setSubjectGrants(env, kind, subject, await payload(request), actor)
}
function userLookup(url, env) {
  const keyword = url.searchParams.get('keyword') ?? ''
  const page = Number(url.searchParams.get('page') || '1')
  if (!keyword.trim() || keyword.length > 100) throw invalid('请输入 1-100 个字符的搜索词')
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw invalid('页码无效')
  return searchUsers(env, keyword.trim(), page)
}
const methods = (method, allowed) => { if (!allowed.includes(method)) throw invalid('method not allowed', 405) }

async function session(request, env, url, principal) {
  if (!principal) return { authenticated: false, tokensapiLogin: organizationSessionReady(env) }
  const org = principal.organizationId
    ? await env.MARKET_DB.prepare('SELECT name FROM market_organizations WHERE id=?').bind(principal.organizationId).first()
    : null
  return {
    authenticated: true, role: principal.role, organizationId: principal.organizationId,
    organizationName: org?.name ?? null, userId: principal.role === 'organization' ? principal.actor.id : null,
    ...(isPlatform(principal) ? { environment: environment(env, organizationProviderReady(env)) } : {}),
  }
}

async function plugins(request, env) {
  const [rows, grants, components] = await Promise.all([pluginRows(env), pluginGrants(env), productComponents(request, env)])
  const items = rows.map(pluginView)
  const resolved = await resolveNpmVersions(selectCatalogSources(items, env, true), env)
  return {
    publisher, components,
    items: resolved.map((item, i) => ({ ...item, registry: items[i].registry, effectiveRegistry: item.registry ?? 'npm',
      access: grants.get(item.id) ?? noGrants() })),
  }
}
async function plugin(env, id) {
  const row = await pluginRow(env, id)
  if (!row) throw invalid('插件不存在', 404)
  return { ...pluginView(row), access: (await pluginGrants(env, id)).get(id) ?? noGrants() }
}

async function npmLookup(url, env) {
  const name = url.searchParams.get('name')
  let registry = url.searchParams.get('registry') || 'npm'
  if (!['npm', 'tokenscowork'].includes(registry)) throw invalid('npm Registry 来源无效')
  if (registry === 'npm' && isPrivateNpmReference(name, env)) registry = 'tokenscowork'
  const version = url.searchParams.get('version') || 'latest'
  return registry === 'tokenscowork' ? privateNpmPackage(name, version, env) : npmPackage(name, version)
}

async function sync(env, principal) {
  try { return { count: await syncOrganizations(env, principal.actor) } }
  catch (error) {
    if (typeof error?.providerCode === 'string' && SYNC_CODES.test(error.providerCode))
      throw invalid('组织服务请求失败（' + error.providerCode + '），请核对上游连接与配置', 503)
    if (/organization listing unavailable/u.test(error?.message ?? '')) throw invalid('未配置 TokensAPI 组织服务', 503)
    throw error
  }
}

async function dispatch(request, env, url, principal) {
  const [head, second, third, fourth] = url.pathname.slice('/api/v1/'.length).split('/').filter(Boolean)
  const method = request.method
  const actor = principal.actor

  if (head === 'plugins') {
    onlyPlatform(principal)
    if (!second) {
      methods(method, ['GET', 'POST'])
      if (method === 'GET') return plugins(request, env)
      const data = await payload(request)
      return createPlugin(request, env, data, actor)
    }
    if (!third) {
      methods(method, ['GET', 'PATCH'])
      return method === 'GET' ? plugin(env, second) : changePlugin(request, env, 'edit', second, await payload(request), actor)
    }
    if (third === 'access' && !fourth) {
      methods(method, ['PUT'])
      return setPluginAccess(env, second, await payload(request), actor)
    }
    if (LIFECYCLE.includes(third) && !fourth) {
      methods(method, ['POST'])
      return changePlugin(request, env, third, second, await payload(request), actor)
    }
  }

  if (head === 'organizations') {
    if (!second) {
      onlyPlatform(principal)
      methods(method, ['GET'])
      return listOrganizations(env)
    }
    if (second === 'sync' && !third) {
      onlyPlatform(principal)
      methods(method, ['POST'])
      return sync(env, principal)
    }
    const id = organizationId(principal, second)
    if (!third) {
      methods(method, ['GET', 'PUT'])
      if (method === 'GET') return getOrganization(env, id)
      onlyPlatform(principal)
      return saveOrganization(env, id, await payload(request), actor)
    }
    if (third === 'grants' && !fourth) {
      if (method !== 'GET') onlyPlatform(principal)
      return grants(request, env, method, 'org', id, actor)
    }
    if (third === 'plugins' && !fourth) {
      methods(method, ['GET'])
      await getOrganization(env, id)
      return organizationPlugins(request, env, id)
    }
    if (third === 'plugins' && fourth) {
      methods(method, ['PUT'])
      return setOrganizationPlugin(request, env, id, fourth, await payload(request), actor)
    }
  }

  if (head === 'keys') {
    onlyPlatform(principal)
    if (!second) {
      methods(method, ['GET', 'POST'])
      return method === 'GET' ? listKeys(env) : addKey(env, await payload(request), actor)
    }
    if (!third) {
      methods(method, ['GET', 'PATCH', 'DELETE'])
      if (method === 'GET') return getKey(env, second)
      if (method === 'PATCH') return updateKey(env, second, await payload(request), actor)
      return deleteKey(env, second, actor)
    }
    if (third === 'grants' && !fourth) return grants(request, env, method, 'key', second, actor)
  }

  if (head === 'users') {
    onlyPlatform(principal)
    if (!second) {
      methods(method, ['GET'])
      return listUsers(env)
    }
    if (second === 'search' && !third) {
      methods(method, ['GET'])
      return userLookup(url, env)
    }
    const id = userId(second)
    if (!id) throw invalid('用户号无效')
    if (!third) {
      methods(method, ['GET', 'PUT', 'DELETE'])
      if (method === 'GET') return getUser(env, id)
      if (method === 'PUT') return saveUser(env, id, await payload(request), actor)
      return deleteUser(env, id, actor)
    }
    if (third === 'grants' && !fourth) return grants(request, env, method, 'user', id, actor)
  }

  if (head === 'audit' && !second) {
    onlyPlatform(principal)
    methods(method, ['GET'])
    return auditLog(env)
  }
  if (head === 'npm-package' && !second) {
    onlyPlatform(principal)
    methods(method, ['GET'])
    return npmLookup(url, env)
  }
  throw invalid('not found', 404)
}

export async function apiRoute(request, env) {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/v1/')) return null
  if (!env.MARKET_DB || !env.MARKET_HMAC_SECRET) return reply({ error: '市场服务未配置' }, 503)
  try {
    const writing = !['GET', 'HEAD'].includes(request.method)
    if (url.pathname === '/api/v1/session') {
      if (request.method === 'GET') return reply(await session(request, env, url, await resolvePrincipal(request, env)))
      methods(request.method, ['PUT', 'DELETE'])
      if (!sameOrigin(request, url)) return reply({ error: '跨站请求被拒绝' }, 403)
      if (request.method === 'DELETE') return reply({ ok: true }, 200, { 'set-cookie': await logout(request, env) })
      const wait = await adminLoginWait(request, env, LOGIN_SCOPE)
      if (wait) return limited(wait)
      try {
        const cookie = await login(request, env, await payload(request))
        await clearAdminLoginFailures(request, env, LOGIN_SCOPE)
        return reply({ ok: true }, 200, { 'set-cookie': cookie })
      } catch (error) {
        // Every refusal spends the budget, whichever credential was offered: the endpoint is
        // unauthenticated, and a free refusal would make it a way to guess the admin token or
        // to point cheap traffic at TokensAPI.
        if (error.status !== 401) throw error
        const blocked = await recordAdminLoginFailure(request, env, LOGIN_SCOPE)
        return blocked ? limited(blocked) : reply({ error: error.message }, 401)
      }
    }
    const token = bearer(request)
    if (token) {
      const wait = await adminLoginWait(request, env, API_SCOPE)
      if (wait) return limited(wait)
    }
    const principal = await resolvePrincipal(request, env)
    if (!principal) {
      const blocked = token ? await recordAdminLoginFailure(request, env, API_SCOPE) : 0
      return blocked ? limited(blocked) : reply({ error: '请先登录，或提供有效的后台口令' }, 401)
    }
    if (principal.via === 'bearer') await clearAdminLoginFailures(request, env, API_SCOPE)
    else if (writing && !sameOrigin(request, url)) return reply({ error: '跨站请求被拒绝' }, 403)
    return reply(await dispatch(request, env, url, principal))
  } catch (error) {
    if ([400, 403, 404, 405, 409, 502, 503].includes(error?.status)) return reply({ error: error.message }, error.status)
    if (/revision conflict|UNIQUE constraint failed: market_plugins/u.test(error?.message ?? '')) return reply({ error: '此插件已被其他操作修改或 ID 已存在，请刷新后重试' }, 409)
    return reply({ error: '市场服务暂时不可用' }, 503)
  }
}
