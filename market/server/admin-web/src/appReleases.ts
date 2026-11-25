import { request } from './api'

/**
 * The app versions in staged rollout, as /api/v1/app-releases answers them, and how the console
 * words them. DOM-free, so it is tested directly.
 */
export type ReleaseStatus = 'draft' | 'rolling' | 'paused' | 'full'
export interface AppRelease {
  version: string
  status: ReleaseStatus
  percent: number
  note: string
  /** Organizations offered it first, whatever the percentage. */
  early: number[]
  /** Organizations never offered it, not even on a manual check. */
  hold: number[]
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

export const loadAppReleases = () => request<{ items: AppRelease[]; installations: Installations }>('/api/v1/app-releases')
export const loadAvailableReleases = () => request<{ items: AvailableRelease[] }>('/api/v1/app-releases/available')

/** Each status: its name and its badge colour. */
export const STATUS: Record<ReleaseStatus, { name: string; color: string; hint: string }> = {
  draft: { name: '草稿', color: 'secondary', hint: '谁都看不到' },
  rolling: { name: '发布中', color: 'blue', hint: '先发组织 + 按比例放量' },
  paused: { name: '已暂停', color: 'orange', hint: '谁都不再提供' },
  full: { name: '全量', color: 'green', hint: '除暂缓组织外所有人' },
}

/** Who a rollout reaches, in one line: the percentage for anyone not on a list. */
export function reachText(release: AppRelease) {
  if (release.status === 'draft' || release.status === 'paused') return '不提供'
  return release.status === 'full' ? '100%' : `${release.percent}%`
}

export const STABLE_VERSION = /^v?(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/u
