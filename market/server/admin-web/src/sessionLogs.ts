import { reactive } from 'vue'
import { request } from './api'

/**
 * What the session-log page reads from /api/v1/session-logs, the account names it draws in, and the
 * download every page of it offers. Every byte of a session is user content (files, commands,
 * secrets): it is only ever placed as text, and each opened session and each download is recorded
 * by the server.
 */
export interface SessionClient {
  product?: string
  version?: string
  platform?: string
}
export interface SessionTokens {
  total: number
  input?: number
  output?: number
}
export interface SessionSummary {
  id: string
  formatVersion: number
  title?: string | null
  client: SessionClient
  parentSession?: string | null
  accountId?: string | null
  keyFingerprint?: string | null
  keyLabel?: string | null
  key?: string | null
  models: string[]
  tokens: SessionTokens
  eventCount: number
  storedBytes: number
  missingEvents?: number
  tags: string[]
  note?: string | null
  cwd?: string | null
  createdAt?: number | null
  firstReceivedAt?: number | null
  lastReceivedAt?: number | null
}
export interface SessionList {
  items: SessionSummary[]
  total: number
  page: number
  pageSize: number
  storedBytes: number
  keyDisplayReady: boolean
}
export interface SessionKey {
  key?: string | null
  fingerprint: string
  label?: string | null
  firstUsedAt?: number
  lastUsedAt?: number
}
export interface SessionEvent {
  seq: number
  type: string
  time?: number
  data?: unknown
  unavailable?: boolean
}
export interface SessionPage {
  session: SessionSummary
  keys: SessionKey[]
  header?: unknown
  events: SessionEvent[]
  next: number | null
}

export const sessionPath = (id: string, formatVersion: number) => `/api/v1/session-logs/${encodeURIComponent(id)}/${formatVersion}`
export const titleOf = (item: { title?: string | null }) => item.title || '未命名会话'

// ── Account names ──────────────────────────────────────────────────────────
/** A reported account as TokensAPI names it: its name and the organization it belongs to now. */
export interface AccountUser {
  id: number | string
  name: string
  organization?: { id: number; name?: string } | null
}
/**
 * Names, and the organization each account belongs to now, for the account ids the clients report:
 * asked once per id for a whole page and drawn in when they arrive, so the list never waits on
 * TokensAPI. `null` is an id nobody could name; a failed request is forgotten so the next load asks
 * again.
 */
export const accounts = reactive(new Map<string, AccountUser | null | 'pending'>())
const numericId = (value: unknown) => (typeof value === 'string' && /^[1-9][0-9]{0,15}$/u.test(value) ? value : '')

export function lookupNames(ids: (string | null | undefined)[]) {
  const missing = [...new Set(ids.map(numericId).filter((id) => id && !accounts.has(id)))]
  if (!missing.length) return
  for (const id of missing) accounts.set(id, 'pending')
  request<{ items: AccountUser[] }>('/api/v1/users/names?ids=' + missing.join(','))
    .then((result) => {
      const found = new Map(result.items.map((user) => [String(user.id), user]))
      for (const id of missing) accounts.set(id, found.get(id) ?? null)
    })
    .catch(() => {
      for (const id of missing) accounts.delete(id)
    })
}
/** The account for one reported id, once known: the user, or null (unknown, pending or unnamed). */
export function accountOf(id: string | null | undefined): AccountUser | null {
  const value = accounts.get(numericId(id))
  return value && value !== 'pending' ? value : null
}
/** 「Runzhou」, 「#9」 (not registered here), 「无组织」, or null when TokensAPI could not tell. */
export function organizationText(user: AccountUser | null) {
  const org = user?.organization
  if (org === undefined) return null
  return org ? org.name || `#${org.id}` : '无组织'
}

// ── Downloads and copying ──────────────────────────────────────────────────
/** One whole session as a file, the same request the server records as a download. */
export async function downloadSessionLog(id: string, formatVersion: number, format: 'json' | 'jsonl') {
  const response = await fetch(`${sessionPath(id, formatVersion)}/raw?format=${format}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  if (!response.ok) {
    let message = '下载失败，请稍后重试。'
    try {
      message = ((await response.json()) as { error?: string }).error || message
    } catch {}
    throw new Error(message)
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = `${id}.${format}`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export async function copyText(text: string, refused: string) {
  if (!navigator.clipboard?.writeText) throw new Error(refused)
  await navigator.clipboard.writeText(text)
}
