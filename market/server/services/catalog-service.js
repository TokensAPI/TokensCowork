import { idOK, text } from '../http/request.js'
import { auditStatements } from './admin-audit-service.js'
import { latestVersion } from '../integrations/npm-registry.js'
import { createRegistryClient } from '../private-registry/client.mjs'
import { selectCatalogSources } from './catalog-source-service.js'

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
export async function catalogRows(env) {
  const { results } = await env.MARKET_DB.prepare(
    'SELECT p.*,c.state,c.revision,c.version_mode,c.license_reference,c.reviewed_version,c.updated_at FROM market_plugins p JOIN market_catalog c ON c.id=p.id ORDER BY p.id',
  ).all()
  return results.map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }))
}
export async function catalogRoster(env, admin = false) {
  const rows = await catalogRows(env)
  return {
    publisher,
    items: rows
      .filter((row) => admin || row.state === 'published')
      .map((row) => ({
        ...row.metadata,
        id: row.id,
        category: 'optional',
        state: row.state,
        revision: row.revision,
        versionMode: row.version_mode,
        licenseReference: row.license_reference,
        reviewedVersion: row.reviewed_version,
      })),
  }
}
export async function catalogEntry(env, id) {
  return env.MARKET_DB.prepare(
    'SELECT p.*,c.state,c.revision,c.version_mode,c.license_reference,c.reviewed_version FROM market_plugins p JOIN market_catalog c ON c.id=p.id WHERE p.id=?',
  )
    .bind(id)
    .first()
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
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v)
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
export function revisionStatement(env, entry, expected = entry.revision) {
  if (!Number.isSafeInteger(expected) || expected !== entry.revision)
    throw invalid('此插件已被其他操作修改，请刷新后重试', 409)
  return env.MARKET_DB.prepare(
    'UPDATE market_catalog SET revision=?,updated_at=? WHERE id=?',
  ).bind(expected + 1, Date.now(), entry.id)
}
export async function catalogMutation(request, env, data) {
  const operation = data.operation
  if (
    !['create', 'edit', 'publish', 'archive', 'trash', 'restore', 'purge'].includes(
      operation,
    )
  )
    throw invalid('不支持的插件操作')
  if (!idOK(data.id)) throw invalid('插件 ID 无效')
  if (operation === 'create') {
    const m = metadata({ ...data.metadata, id: data.id })
    const components = await productComponents(request, env)
    if (
      components.items.some(
        (item) => item.id === m.id || item.package === m.package,
      )
    )
      throw invalid('这是应用内置组件，不能作为市场插件创建', 409)
    if (
      await env.MARKET_DB.prepare('SELECT 1 FROM market_plugins WHERE id=?')
        .bind(m.id)
        .first()
    )
      throw invalid(
        '插件 ID 已存在（包括回收站），请选择其他 ID 或恢复原插件',
        409,
      )
    const mode = m.npm ? 'latest' : 'pinned'
    await env.MARKET_DB.batch([
      env.MARKET_DB.prepare(
        'INSERT INTO market_plugins(id,visibility,metadata) VALUES(?,?,?)',
      ).bind(m.id, 'public', JSON.stringify(m)),
      env.MARKET_DB.prepare(
        "INSERT INTO market_catalog(id,state,version_mode,updated_at) VALUES(?,'draft',?,?)",
      ).bind(m.id, mode, Date.now()),
      ...auditStatements(env, 'catalog.created', m.id, { state: 'draft' }),
    ])
    return { ok: true, state: 'draft' }
  }
  const entry = await catalogEntry(env, data.id)
  if (!entry) throw invalid('插件不存在', 404)
  if (!Number.isSafeInteger(data.revision)) throw invalid('缺少插件修订号，请刷新后重试',409)
  revisionStatement(env, entry, data.revision)
  if (operation === 'purge') {
    if (entry.state !== 'deleted') throw invalid('只能彻底删除回收站中的插件', 409)
    if (data.confirmId !== entry.id) throw invalid('请输入完整插件 ID 确认彻底删除')
    await env.MARKET_DB.batch([
      revisionStatement(env, entry, data.revision),
      ...['market_plugin_key_values', 'market_plugin_key_grants', 'market_org_grants', 'market_org_policies', 'market_grants']
        .map(table => env.MARKET_DB.prepare(`DELETE FROM ${table} WHERE plugin_id=?`).bind(entry.id)),
      env.MARKET_DB.prepare('DELETE FROM market_catalog WHERE id=?').bind(entry.id),
      env.MARKET_DB.prepare('DELETE FROM market_plugins WHERE id=?').bind(entry.id),
      ...auditStatements(env, 'catalog.purge', entry.id, { state: 'purged' }),
    ])
    return { ok: true, state: 'purged' }
  }
  let nextState = entry.state,
    m = JSON.parse(entry.metadata),
    mode = entry.version_mode
  let reference = entry.license_reference,
    reviewed = entry.reviewed_version
  if (operation === 'edit') {
    if (entry.state === 'deleted') throw invalid('请先从回收站恢复插件', 409)
    const next = metadata({ ...data.metadata, id: data.id })
    const components = await productComponents(request, env)
    if (
      components.items.some(
        (item) => item.id === next.id || item.package === next.package,
      )
    )
      throw invalid('应用内置组件不能作为市场插件分发', 409)
    mode = next.npm ? 'latest' : 'pinned'
    if (sourceIdentity(m) !== sourceIdentity(next)) {
      reference = ''
      reviewed = ''
      nextState = 'draft'
    }
    m = next
  } else if (operation === 'publish') {
    if (!['draft', 'archived'].includes(entry.state))
      throw invalid('只能上架草稿或已下架插件', 409)
    if (m.npm) {
      const latest = await catalogLatestVersion(env, m)
      if (!latest) throw invalid('npm latest 暂无可用稳定版本或查询失败，请发布稳定版后重试上架')
      m = {...m, version: latest}
      mode = 'latest'
    }
    if (!stable(m.version))
      throw invalid('预发布版本可以保存草稿；当前桌面安装器只支持稳定版本，请发布稳定版后再上架')
    // Publication is an authenticated administrator action, not a license scan.
    // The repository's dependency license gate remains a separate release responsibility.
    const suppliedReference = data.licenseReference ?? ''
    if (suppliedReference !== '') {
      let validReference = false
      try {
        const url = new URL(suppliedReference)
        validReference = text(suppliedReference, 500) && suppliedReference === suppliedReference.trim()
          && url.protocol === 'https:' && !url.username && !url.password
      } catch {}
      if (!validReference) throw invalid('检查记录链接须为有效的 HTTPS 地址，也可留空')
    }
    metadata(m)
    if (entry.visibility === 'public' && data.confirmPublic !== true)
      throw invalid('此插件未限制访问范围，请明确确认公开上架', 409)
    reference = suppliedReference
    reviewed = m.version
    nextState = 'published'
  } else if (operation === 'archive') {
    if (entry.state !== 'published')
      throw invalid('只有已上架插件可以下架', 409)
    nextState = 'archived'
  } else if (operation === 'trash') {
    if (!['draft', 'archived'].includes(entry.state))
      throw invalid('请先下架插件，再移入回收站', 409)
    nextState = 'deleted'
  } else {
    if (entry.state !== 'deleted') throw invalid('插件不在回收站', 409)
    nextState = 'draft'
  }
  await env.MARKET_DB.batch([
    env.MARKET_DB.prepare(
      'UPDATE market_catalog SET state=?,version_mode=?,license_reference=?,reviewed_version=?,revision=?,updated_at=? WHERE id=?',
    ).bind(
      nextState,
      mode,
      reference,
      reviewed,
      entry.revision + 1,
      Date.now(),
      entry.id,
    ),
    env.MARKET_DB.prepare(
      'UPDATE market_plugins SET metadata=? WHERE id=?',
    ).bind(JSON.stringify(m), entry.id),
    ...auditStatements(env, 'catalog.' + operation, entry.id, {
      state: nextState,
    }),
  ])
  return { ok: true, state: nextState }
}
