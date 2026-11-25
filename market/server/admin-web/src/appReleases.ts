import { request } from './api'

/**
 * The app versions in staged rollout, as /api/v1/app-releases answers them, and how the console
 * words them. DOM-free, so it is tested directly.
 */
export type ReleaseStatus = 'draft' | 'rolling' | 'paused' | 'full'
/** A user named on a list; `organization` is null for "belongs to none", absent when unknown. */
export interface ReleaseUser {
  id: number
  name: string | null
  organization?: { id: number; name: string | null } | null
}
export interface AppRelease {
  version: string
  status: ReleaseStatus
  percent: number
  note: string
  /** Organizations offered it first, whatever the percentage. */
  early: number[]
  /** Organizations never offered it, not even on a manual check. */
  hold: number[]
  /** Users offered it first; a user's setting comes before their organization's. */
  earlyUsers: ReleaseUser[]
  /** Users never offered it, not even on a manual check. */
  holdUsers: ReleaseUser[]
  /** Installs (checked within the last 7 days) running it, or whose latest check was answered with it. */
  offered: number
  /** Installs (checked within the last 7 days) running it. */
  upgraded: number
  createdAt: number
  updatedAt: number
}
export interface Installations {
  days: number
  total: number
  versions: { version: string; count: number }[]
}
export interface AvailableRelease {
  version: string
  prerelease: boolean
  publishedAt: string | null
}
/** What GitHub says about a version, in one line. */
export interface ReleaseBrief extends AvailableRelease {
  summary: string
}
/** Everything the detail page shows about a version. */
export interface ReleaseInfo extends ReleaseBrief {
  name: string
  url: string | null
  highlights: { title: string; items: string[] }[]
  components: { name: string; version: string }[]
  installers: { name: string; size: number | null; url: string | null }[]
}

export const loadAppReleases = () => request<{ items: AppRelease[]; installations: Installations }>('/api/v1/app-releases')
export const loadAvailableReleases = () => request<{ items: AvailableRelease[] }>('/api/v1/app-releases/available')
export const loadReleaseBriefs = () => request<{ items: ReleaseBrief[] }>('/api/v1/app-releases/info')
export const loadReleaseInfo = (version: string) => request<ReleaseInfo>(`/api/v1/app-releases/${version}/info`)

/** Each status: its name, its badge colour, and what it means in one sentence. */
export const STATUS: Record<ReleaseStatus, { name: string; color: string; hint: string; meaning: string }> = {
  draft: { name: '草稿', color: 'secondary', hint: '谁都看不到', meaning: '还没有开始发布，任何人都收不到这个版本，手动检查更新也收不到。可以先把下面的范围设置好。' },
  rolling: { name: '发布中', color: 'blue', hint: '先发名单 + 按比例放量', meaning: '正在按下面的范围发布：先发名单里的一定能看到，其余的人按比例看到。任何人自己点「检查更新」都能拿到（暂缓名单除外）。' },
  paused: { name: '已暂停', color: 'orange', hint: '谁都不再提供', meaning: '已暂停：不再提供给任何人，手动检查更新也收不到。已经装上的人不受影响。' },
  full: { name: '全量', color: 'green', hint: '除暂缓名单外所有人', meaning: '已给所有人：除暂缓名单外，所有人都会看到这个版本。' },
}

const counted = (orgs: number, users: number) => [orgs ? `${orgs} 个组织` : '', users ? `${users} 个用户` : ''].filter(Boolean).join('、')

/** The lists and percentage of a rollout as one phrase: 「先发：2 个组织、3 个用户 · 其余 20% · 暂缓：1 个组织」. */
export function scopePlan(release: Pick<AppRelease, 'status' | 'percent' | 'early' | 'hold' | 'earlyUsers' | 'holdUsers'>) {
  const early = counted(release.early.length, release.earlyUsers.length)
  const hold = counted(release.hold.length, release.holdUsers.length)
  const rest = release.status === 'full' ? '其余所有人' : `其余 ${release.percent}%`
  return [early ? `先发：${early}` : '', rest, hold ? `暂缓：${hold}` : ''].filter(Boolean).join(' · ')
}

/** Who a rollout reaches right now, in plain words, for the list of versions. */
export function scopeText(release: AppRelease) {
  if (release.status === 'draft') return '还没有人能收到'
  if (release.status === 'paused') return '已暂停，不再提供给任何人'
  if (release.status === 'full') {
    const hold = counted(release.hold.length, release.holdUsers.length)
    return hold ? `所有人 · 暂缓：${hold}` : '所有人'
  }
  return scopePlan(release)
}

/** A file size in MB (or KB below one MB). */
export function sizeText(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return ''
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** A listed user by name and number, with their organization when known. */
export function releaseUserLabel(user: ReleaseUser) {
  return `${user.name ?? '用户'} (#${user.id})`
}

export const STABLE_VERSION = /^v?(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/u
