import { formatTime } from './shell'
import { STATE_NAMES } from './plugins'

/**
 * The activity log's wording: what each change is called, who made
 * it, what it was made to, and the facts its details carry. DOM-free, so it is tested directly.
 */
export interface AuditEvent {
  action: string
  target: string
  actor?: { kind?: string; id?: string; organizationId?: number | null } | null
  details?: Record<string, unknown> | null
  createdAt: number
}
/** How the subjects of a change are named on screen. */
export interface Names {
  organization: (id: number) => string
  key: (fingerprint: string) => string
  user: (id: string) => string
  plugin: (id: string) => string
}

export const ACTIONS: Record<string, string> = {
  'catalog.created': '新建插件',
  'catalog.edit': '编辑插件',
  'catalog.publish': '上架插件',
  'catalog.archive': '下架插件',
  'catalog.trash': '移入回收站',
  'catalog.restore': '恢复插件',
  'catalog.purge': '彻底删除插件',
  'plugin.access.updated': '更新访问范围',
  'organization.updated': '维护组织',
  'organizations.synced': '同步组织名录',
  'tenant.plugin.updated': '组织插件设置',
  'key.added': '登记 Key',
  'key.updated': '修改 Key 备注',
  'key.deleted': '删除 Key',
  'grants.updated': '配置插件授权',
  'user.updated': '维护用户',
  'user.deleted': '移除用户',
  'session-log.viewed': '查看会话日志',
  'session-log.downloaded': '下载会话日志',
  'session-log.deleted': '删除会话日志',
  'session-log.settings': '设置日志保留期',
  'session-log.purged': '清理过期会话日志',
  'session-log.annotated': '修改会话备注',
  'plugin.icon.updated': '更新插件图标',
  'plugin.icon.deleted': '移除插件图标',
  'plugin.doc.saved': '保存插件文档',
  'plugin.doc.deleted': '删除插件文档',
  'plugin.doc.image.uploaded': '上传文档图片',
  'plugin.doc.image.deleted': '删除文档图片',
  'app-release.created': '新建灰度版本',
  'app-release.updated': '修改灰度版本',
  'app-release.deleted': '删除灰度草稿',
}

export function actorText(actor: AuditEvent['actor']) {
  if (actor?.kind === 'tenant') return `组织管理员 · 用户 ${actor.id}${actor.organizationId ? ` · 组织 #${actor.organizationId}` : ''}`
  if (actor?.kind === 'root' && actor.id?.startsWith('tokensapi:'))
    return `平台口令 · TokensAPI 代用户 ${actor.id.slice('tokensapi:'.length)}${actor.organizationId ? ` · 组织 #${actor.organizationId}` : ''}`
  if (actor?.kind === 'root' && actor.id === 'retention') return '保留期 · 自动清理'
  if (actor?.kind === 'root') return actor.id === 'token' ? '平台管理员 · 口令' : '平台管理员 · 会话'
  return '历史记录'
}

export function targetText(event: AuditEvent, names: Names) {
  if (event.action === 'tenant.plugin.updated') {
    const [org = '', plugin = ''] = event.target.split(':')
    return `${names.organization(Number(org))} · ${names.plugin(plugin)}`
  }
  if (event.action === 'grants.updated') {
    const [kind, subject = ''] = event.target.split(':')
    return kind === 'org' ? names.organization(Number(subject)) : kind === 'key' ? names.key(subject) : names.user(subject)
  }
  if (event.action.startsWith('plugin.doc.')) return `${names.plugin(event.target.split(':')[0] ?? '')} · 文档 #${event.target.split(':')[1]}`
  if (event.action.startsWith('app-release.')) return `版本 ${event.target}`
  if (event.action.startsWith('key.')) return names.key(event.target)
  if (event.action.startsWith('user.')) return names.user(event.target)
  if (event.action === 'organization.updated') return names.organization(Number(event.target))
  if (event.action === 'organizations.synced') return ''
  if (event.action.startsWith('session-log.'))
    return event.target === 'range' ? '按日期' : event.target === 'retention' ? '' : event.target.replace(/:(\d+)$/u, '（格式 v$1）')
  return names.plugin(event.target)
}

export function factsText(event: AuditEvent) {
  const d = (event.details || {}) as Record<string, any>
  const facts: string[] = []
  if (d.state) facts.push({ ...STATE_NAMES, purged: '已彻底删除' }[d.state as string] || d.state)
  if (d.visibility) facts.push(d.visibility === 'public' ? '公开' : '受限')
  if (d.organizationCount != null) facts.push(`${d.organizationCount} 个组织`)
  if (d.keyCount != null) facts.push(`${d.keyCount} 个 Key`)
  if (d.userCount != null) facts.push(`${d.userCount} 个用户`)
  if (d.pluginCount != null) facts.push(`共 ${d.pluginCount} 个插件（新增 ${d.added}，撤销 ${d.removed}）`)
  if (d.count != null) facts.push(`${d.count} 个${event.action.startsWith('session-log.') ? '会话' : '组织'}`)
  if ('retentionDays' in d) facts.push(d.retentionDays ? `保留 ${d.retentionDays} 天` : '永久保留')
  if (event.action === 'session-log.downloaded') facts.push(d.format === 'jsonl' ? '下载 JSONL' : '下载 JSON')
  if (event.action === 'session-log.deleted' && Number.isSafeInteger(d.to)) facts.push(`创建于 ${formatTime(d.from ?? 0)} 至 ${formatTime(d.to)}`)
  if (event.action === 'session-log.annotated') facts.push(d.tags?.length ? `标签：${d.tags.join('、')}` : '无标签', d.note ? '有备注' : '无备注')
  if (event.action === 'plugin.icon.updated' && d.bytes != null) facts.push(`${Math.max(1, Math.round(d.bytes / 1024))} KB`)
  if (event.action === 'plugin.doc.saved') facts.push(d.created ? '新增' : '替换')
  if (event.action === 'plugin.doc.image.uploaded' && d.bytes != null) facts.push(`${Math.max(1, Math.round(d.bytes / 1024))} KB`)
  if (event.action === 'app-release.updated') {
    const status = ({ draft: '草稿', rolling: '发布中', paused: '已暂停', full: '全量' } as Record<string, string>)[d.status as string]
    if (status) facts.push(status)
    if (d.percent != null) facts.push(`比例 ${d.percent}%`)
    facts.push(`先发 ${d.earlyCount ?? 0} 个组织`, `暂缓 ${d.holdCount ?? 0} 个组织`)
    if (d.earlyUserCount != null || d.holdUserCount != null) facts.push(`先发 ${d.earlyUserCount ?? 0} 个用户`, `暂缓 ${d.holdUserCount ?? 0} 个用户`)
  }
  if (d.grantCount != null) facts.push(`移除 ${d.grantCount} 项授权`)
  if (typeof d.enabled === 'boolean') facts.push(d.enabled ? '开启' : '关闭')
  if (d.memberCount != null) facts.push(d.memberCount ? `指定 ${d.memberCount} 位成员可见` : '全员可见')
  return facts.join(' · ') || (event.action === 'session-log.viewed' ? '打开了会话详情' : '已保存')
}
