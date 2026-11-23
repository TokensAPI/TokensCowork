import { request } from './api'
import type { MarketKey } from './pages/KeysPage.vue'

/**
 * The market's directories as the console reads them, and how each subject is named on screen --
 * the same wording as /admin/ (an organization 「名称 (#7)」, a user 「名称 (#102)」, a Key by its
 * note, else its value). A page reads the directories it needs itself; nothing here is cached.
 */
export interface Organization {
  id: number
  name: string
  enabled: boolean
  /** How many plugins the platform grants it. */
  granted?: number
  /** How many granted plugins its administrator switched off. */
  hidden?: number
}
export interface MarketUser {
  id: number
  name: string
  plugins: string[]
}

export const loadOrganizations = () => request<{ items: Organization[]; syncReady: boolean }>('/api/v1/organizations')
export const loadUsers = () => request<{ items: MarketUser[]; searchReady: boolean }>('/api/v1/users')
export const loadKeys = () => request<{ items: MarketKey[]; displayReady: boolean }>('/api/v1/keys')

export function organizationLabel(list: Organization[], id: number) {
  const org = list.find((item) => item.id === id)
  return org ? `${org.name} (#${id})` : `组织 #${id}`
}
export function userLabel(list: MarketUser[], id: number | string) {
  const user = list.find((item) => item.id === Number(id))
  return user ? `${user.name} (#${id})` : `用户 #${id}`
}
/** A Key by its note, else its own value; the internal id is never shown. */
export function keyLabel(list: MarketKey[], fingerprint: string) {
  const key = list.find((item) => item.fingerprint === fingerprint)
  if (!key) return 'Key（已删除）'
  return key.label || key.apiKey || '未命名 Key'
}
