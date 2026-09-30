import { idOK, text } from '../http/request.js'
import { auditStatements } from './audit.js'
import { latestVersion } from '../integrations/npm-registry.js'
import { createRegistryClient } from '../private-registry/client.mjs'
import { selectCatalogSources } from './catalog-source-service.js'
import { validOrganizationId } from './organizations.js'

export const publisher = {
  name: 'TokensAPI',
  url: 'https://github.com/TokensAPI',
}
export const packageOK = (value) =>
  typeof value === 'string' &&
  value === value.trim() &&
  value.length <= 160 &&
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(value)
export const stable = (value) =>
  versionOK(value) && !value.split('+')[0].includes('-')
export const versionOK = (value) =>
  typeof value === 'string' && value.length <= 64 && value === value.trim() &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u.test(value)
export function invalid(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}
export const fingerprintOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

// The shape every caller sees: package metadata flattened with the plugin's lifecycle fields.
export const pluginView = (row) => ({
  ...row.metadata,
  id: row.id,
  category: 'optional',
  visibility: row.visibility,
  state: row.state,
  revision: row.revision,
  versionMode: row.version_mode,
  licenseReference: row.license_reference,
  reviewedVersion: row.reviewed_version,
  updatedAt: row.updated_at,
})

export async function pluginRows(env) {
  const { results } = await env.MARKET_DB.prepare('SELECT * FROM market_plugins ORDER BY id').all()
  return results.map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }))
}
export async function pluginRow(env, id) {
  const row = await env.MARKET_DB.prepare('SELECT * FROM market_plugins WHERE id=?').bind(id).first()
  return row ? { ...row, metadata: JSON.parse(row.metadata) } : null
}
// Who a plugin is granted to, keyed by plugin id. Only restricted plugins consult it.
export async function pluginGrants(env, pluginId = null) {
  const { results } = await (pluginId
    ? env.MARKET_DB.prepare('SELECT plugin_id,kind,subject FROM market_grants WHERE plugin_id=? ORDER BY kind,subject').bind(pluginId)
    : env.MARKET_DB.prepare('SELECT plugin_id,kind,subject FROM market_grants ORDER BY kind,subject')).all()
  const grants = new Map()
  for (const row of results) {
    if (!grants.has(row.plugin_id)) grants.set(row.plugin_id, noGrants())
    const entry = grants.get(row.plugin_id)
    if (row.kind === 'org') entry.organizations.push(Number(row.subject))
    else if (row.kind === 'user') entry.users.push(Number(row.subject))
    else entry.keys.push(row.subject)
  }
  return grants
}
export const noGrants = () => ({ organizations: [], keys: [], users: [] })

export async function catalogRoster(env) {
  const rows = await pluginRows(env)
  return { publisher, items: rows.filter((row) => row.state === 'published').map(pluginView) }
}

export async function catalogLatestVersion(env, item) {
  if (selectCatalogSources([item], env, true)[0].registry === 'tokenscowork') return await createRegistryClient(env).latestVersion(item.package)
  return await latestVersion(item.package, '')
}

export async function productComponents(request, env) {
  const response = await env.ASSETS.fetch(
    new URL('/product-components.json', request.url).toString(),
  )
  if (!response.ok) throw invalid('产品组件清单未生成，请检查部署', 503)
  const result = await response.json()
  if (!Array.isArray(result.items)) throw invalid('产品组件清单无效', 503)
  return result
}
function metadata(value) {
  const plain = (v, max) =>
    text(v, max) &&
    !/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(v)
  if (
    !value ||
    !idOK(value.id) ||
    !packageOK(value.package) ||
    !plain(value.displayName, 120) ||
    !plain(value.summary, 1000) ||
    !versionOK(value.version) ||
    typeof value.npm !== 'boolean'
  )
    throw invalid(
      '请填写有效的 ID、npm 包名、名称、简介及版本（例如 1.0.0 或 0.1.0-beta.1）',
    )
  const registry = value.npm ? (value.registry ?? 'npm') : 'github'
  if (value.npm && !['npm', 'tokenscowork'].includes(registry)) throw invalid('npm 来源只能选择公开 npm 或 TokensCowork 自建 Registry')
  if (!value.npm && value.registry !== undefined) throw invalid('GitHub 插件不能设置 npm Registry 来源')
  const repository = value.repository ?? ''
  if (!(value.npm && repository === '') && (
    typeof repository !== 'string' ||
    repository !== repository.trim() ||
    !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(
      repository,
    )
  ))
    throw invalid('仓库地址须为 https://github.com/组织/仓库，不含查询参数')
  if (!value.npm && (typeof value.installSource?.commit !== 'string' || value.installSource.commit.length !== 40 || !/^[a-f0-9]{40}$/u.test(value.installSource.commit)))
    throw invalid('GitHub 安装须指定完整的 40 位 Git commit')
  return {
    id: value.id,
    category: 'optional',
    package: value.package,
    displayName: value.displayName.trim(),
    summary: value.summary.trim(),
    repository,
    version: value.version,
    npm: value.npm,
    ...(value.npm ? { registry } : {}),
    ...(!value.npm
      ? {
          installSource: { kind: 'github', commit: value.installSource.commit },
        }
      : {}),
  }
}
const sourceIdentity = (m) =>
  JSON.stringify([
    m.package,
    m.repository,
    m.npm,
    m.version,
    m.installSource?.commit,
    m.registry,
  ])
async function rejectBuiltin(request, env, m) {
  const components = await productComponents(request, env)
  if (components.items.some((item) => item.id === m.id || item.package === m.package))
    throw invalid('这是应用内置组件，不能作为市场插件分发', 409)
}
// Every write names the revision it was based on. The UPDATE sets revision+1 and the
// market_plugin_revision trigger rejects anything else, so a stale write can never land.
async function current(env, id, revision) {
  const entry = await pluginRow(env, id)
  if (!entry) throw invalid('插件不存在', 404)
  if (!Number.isSafeInteger(revision)) throw invalid('缺少插件修订号，请刷新后重试', 409)
  if (revision !== entry.revision) throw invalid('此插件已被其他操作修改，请刷新后重试', 409)
  return entry
}

export async function createPlugin(request, env, data, actor) {
  const m = metadata({ ...data.metadata, id: data.id })
  await rejectBuiltin(request, env, m)
  if (await env.MARKET_DB.prepare('SELECT 1 FROM market_plugins WHERE id=?').bind(m.id).first())
    throw invalid('插件 ID 已存在（包括回收站），请选择其他 ID 或恢复原插件', 409)
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare("INSERT INTO market_plugins(id,visibility,state,metadata,version_mode,updated_at) VALUES(?,'public','draft',?,?,?)")
      .bind(m.id, JSON.stringify(m), m.npm ? 'latest' : 'pinned', Date.now()),
    ...auditStatements(env, 'catalog.created', m.id, { state: 'draft' }, actor),
  ])
  return { ok: true, state: 'draft', revision: 1 }
}

const OPERATIONS = ['edit', 'publish', 'archive', 'trash', 'restore', 'purge']
export async function changePlugin(request, env, operation, id, data, actor) {
  if (!OPERATIONS.includes(operation)) throw invalid('不支持的插件操作')
  if (!idOK(id)) throw invalid('插件 ID 无效')
  const entry = await current(env, id, data.revision)
  if (operation === 'purge') {
    if (entry.state !== 'deleted') throw invalid('只能彻底删除回收站中的插件', 409)
    if (data.confirmId !== entry.id) throw invalid('请输入完整插件 ID 确认彻底删除')
    // Grants and organization switches cascade with the row.
    await env.MARKET_DB.batch([
      env.MARKET_DB.prepare('UPDATE market_plugins SET revision=? WHERE id=?').bind(entry.revision + 1, entry.id),
      env.MARKET_DB.prepare('DELETE FROM market_plugins WHERE id=?').bind(entry.id),
      ...auditStatements(env, 'catalog.purge', entry.id, { state: 'purged' }, actor),
    ])
    return { ok: true, state: 'purged' }
  }
  let state = entry.state, m = entry.metadata, mode = entry.version_mode
  let reference = entry.license_reference, reviewed = entry.reviewed_version
  if (operation === 'edit') {
    if (entry.state === 'deleted') throw invalid('请先从回收站恢复插件', 409)
    const next = metadata({ ...data.metadata, id })
    await rejectBuiltin(request, env, next)
    mode = next.npm ? 'latest' : 'pinned'
    // A different package, source or version is a different thing to review.
    if (sourceIdentity(m) !== sourceIdentity(next)) {
      reference = ''
      reviewed = ''
      state = 'draft'
    }
    m = next
  } else if (operation === 'publish') {
    if (!['draft', 'archived'].includes(entry.state)) throw invalid('只能上架草稿或已下架插件', 409)
    if (m.npm) {
      const latest = await catalogLatestVersion(env, m)
      if (!latest) throw invalid('npm latest 暂无可用稳定版本或查询失败，请发布稳定版后重试上架')
      m = { ...m, version: latest }
      mode = 'latest'
    }
    if (!stable(m.version))
      throw invalid('预发布版本可以保存草稿；当前桌面安装器只支持稳定版本，请发布稳定版后再上架')
    // Publication is an authenticated administrator action, not a license scan.
    // The repository's dependency license gate remains a separate release responsibility.
    const supplied = data.licenseReference ?? ''
    if (supplied !== '') {
      let valid = false
      try {
        const url = new URL(supplied)
        valid = text(supplied, 500) && supplied === supplied.trim()
          && url.protocol === 'https:' && !url.username && !url.password
      } catch {}
      if (!valid) throw invalid('检查记录链接须为有效的 HTTPS 地址，也可留空')
    }
    metadata(m)
    if (entry.visibility === 'public' && data.confirmPublic !== true)
      throw invalid('此插件未限制访问范围，请明确确认公开上架', 409)
    reference = supplied
    reviewed = m.version
    state = 'published'
  } else if (operation === 'archive') {
    if (entry.state !== 'published') throw invalid('只有已上架插件可以下架', 409)
    state = 'archived'
  } else if (operation === 'trash') {
    if (!['draft', 'archived'].includes(entry.state)) throw invalid('请先下架插件，再移入回收站', 409)
    state = 'deleted'
  } else {
    if (entry.state !== 'deleted') throw invalid('插件不在回收站', 409)
    state = 'draft'
  }
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('UPDATE market_plugins SET state=?,metadata=?,version_mode=?,license_reference=?,reviewed_version=?,revision=?,updated_at=? WHERE id=?')
      .bind(state, JSON.stringify(m), mode, reference, reviewed, entry.revision + 1, Date.now(), entry.id),
    ...auditStatements(env, 'catalog.' + operation, entry.id, { state }, actor),
  ])
  return { ok: true, state, revision: entry.revision + 1 }
}

// Whether every value names a row that exists: an organization, a Key or a user.
const SUBJECTS = {
  org: { table: 'market_organizations', column: 'id', valid: validOrganizationId, missing: '所选组织不存在，请先同步组织' },
  key: { table: 'market_keys', column: 'fingerprint', valid: fingerprintOK, missing: '所选 Key 不存在，请刷新后重试' },
  user: { table: 'market_users', column: 'id', valid: validOrganizationId, missing: '所选用户不存在，请先添加用户' },
}
async function known(env, kind, values) {
  if (!values.length) return true
  const { table, column } = SUBJECTS[kind]
  const { results } = await env.MARKET_DB.prepare(`SELECT ${column} FROM ${table} WHERE ${column} IN (${values.map(() => '?').join(',')})`).bind(...values).all()
  return results.length === values.length
}
const subjectList = (kind, value, label) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100 || !value.every(SUBJECTS[kind].valid)) throw invalid(`${label}列表无效，最多 100 个`)
  return [...new Set(value)]
}

// An organization's switch and member list only narrow its grant; losing the grant takes them
// along, so granting the plugin again starts afresh with every member.
const dropUngranted = (env, pluginId) => ['market_org_hidden', 'market_org_members'].map(table =>
  env.MARKET_DB.prepare(`DELETE FROM ${table} WHERE plugin_id=? AND organization_id NOT IN
    (SELECT CAST(subject AS INTEGER) FROM market_grants WHERE plugin_id=? AND kind='org')`).bind(pluginId, pluginId))

// The whole access configuration in one write: the scope, and who a restricted plugin is
// granted to. A public plugin keeps its grants, so switching back to restricted restores them.
export async function setPluginAccess(env, id, data, actor) {
  if (!idOK(id)) throw invalid('插件 ID 无效')
  if (!['public', 'restricted'].includes(data.visibility)) throw invalid('访问范围无效')
  const chosen = { org: subjectList('org', data.organizations, '组织'), key: subjectList('key', data.keys, 'Key'), user: subjectList('user', data.users, '用户') }
  const entry = await current(env, id, data.revision)
  if (entry.state === 'deleted') throw invalid('请先从回收站恢复插件', 409)
  for (const kind of Object.keys(chosen)) if (!await known(env, kind, chosen[kind])) throw invalid(SUBJECTS[kind].missing)
  const grant = (kind, subject) => env.MARKET_DB.prepare('INSERT INTO market_grants(plugin_id,kind,subject) VALUES(?,?,?)').bind(id, kind, String(subject))
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare('UPDATE market_plugins SET visibility=?,revision=?,updated_at=? WHERE id=?')
      .bind(data.visibility, entry.revision + 1, Date.now(), id),
    env.MARKET_DB.prepare('DELETE FROM market_grants WHERE plugin_id=?').bind(id),
    ...Object.entries(chosen).flatMap(([kind, values]) => values.map(value => grant(kind, value))),
    ...dropUngranted(env, id),
    ...auditStatements(env, 'plugin.access.updated', id, { visibility: data.visibility,
      organizationCount: chosen.org.length, keyCount: chosen.key.length, userCount: chosen.user.length }, actor),
  ])
  return { ok: true, visibility: data.visibility, revision: entry.revision + 1 }
}

// The same grants read from the other side: which plugins one organization, Key or user holds.
// Plugins in the recycle bin keep their grants and are left out of both the answer and the write.
export async function subjectGrants(env, kind, subject) {
  if (!await known(env, kind, [subject])) throw invalid(SUBJECTS[kind].missing.replace('所选', ''), 404)
  const { results } = await env.MARKET_DB.prepare(`SELECT g.plugin_id FROM market_grants g JOIN market_plugins p ON p.id=g.plugin_id
    WHERE g.kind=? AND g.subject=? AND p.state!='deleted' ORDER BY g.plugin_id`).bind(kind, String(subject)).all()
  return { plugins: results.map(row => row.plugin_id) }
}

// Replace everything one subject holds. Each plugin whose grants change takes a revision step,
// so an access dialog opened before this write cannot silently overwrite it.
export async function setSubjectGrants(env, kind, subject, data, actor) {
  const plugins = data?.plugins
  if (!Array.isArray(plugins) || plugins.length > 500 || !plugins.every(idOK)) throw invalid('插件列表无效，最多 500 个')
  const wanted = new Set(plugins)
  const { results } = await env.MARKET_DB.prepare("SELECT id FROM market_plugins WHERE state!='deleted'").all()
  const live = new Set(results.map(row => row.id))
  const unknown = [...wanted].filter(id => !live.has(id))
  if (unknown.length) throw invalid(`插件不存在或在回收站：${unknown.join('、')}`)
  const held = new Set((await subjectGrants(env, kind, subject)).plugins)
  const added = [...wanted].filter(id => !held.has(id)), removed = [...held].filter(id => !wanted.has(id))
  const changed = [...added, ...removed]
  const now = Date.now()
  await env.MARKET_DB.batch([
    ...removed.map(id => env.MARKET_DB.prepare('DELETE FROM market_grants WHERE plugin_id=? AND kind=? AND subject=?').bind(id, kind, String(subject))),
    ...added.map(id => env.MARKET_DB.prepare('INSERT INTO market_grants(plugin_id,kind,subject) VALUES(?,?,?)').bind(id, kind, String(subject))),
    ...(kind === 'org' ? removed.flatMap(id => dropUngranted(env, id)) : []),
    ...changed.map(id => env.MARKET_DB.prepare('UPDATE market_plugins SET revision=revision+1,updated_at=? WHERE id=?').bind(now, id)),
    ...auditStatements(env, 'grants.updated', `${kind}:${subject}`, { pluginCount: wanted.size, added: added.length, removed: removed.length }, actor),
  ])
  return { ok: true, plugins: [...wanted].sort() }
}
