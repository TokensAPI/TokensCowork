import { computed, reactive } from 'vue'
import { request, onSessionExpired, SESSION_PATH } from './api'
import { VIEWS } from './views'

/** GET /api/v1/session, as the market answers it. */
export interface Session {
  authenticated: true
  role: 'platform' | 'organization'
  organizationId: number | null
  organizationName: string | null
  userId: string | null
  environment?: { name?: string; origin?: string; preview?: boolean; keyDisplayReady?: boolean; privateRegistryReady?: boolean }
}

/**
 * Who is signed in, shared by the whole console: one session cookie (also read by the docs center
 * opened as the administrator), from the back-office passphrase or a TokensAPI organization
 * administrator's account. `pending` holds while the cookie is being checked on load.
 */
export const state = reactive({ pending: true, session: null as Session | null })

export const isPlatform = computed(() => state.session?.role === 'platform')
/** The pages this account may open, all, or its own organization. */
export const allowedViews = computed(() => (isPlatform.value ? VIEWS.map((view) => view.id) : state.session ? ['organizations'] : []))

/** The environment badge. */
export const environmentLabel = computed(() => {
  const session = state.session
  if (!session) return ''
  if (session.role !== 'platform') return `${session.organizationName || '组织 #' + session.organizationId} · 组织管理员`
  const env = session.environment ?? {}
  if (env.preview) return '生产快照 · 本地'
  return ({ production: '正式环境', development: '测试环境' } as Record<string, string>)[env.name ?? ''] || '未配置环境'
})

const listeners = new Set<(signedIn: boolean) => void>()
/** Told whenever the console signs in or out (the router re-checks the page it is on). */
export function onSessionChange(listener: (signedIn: boolean) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function set(session: Session | null) {
  const before = !!state.session
  state.session = session
  if (before !== !!session) for (const listener of listeners) listener(!!session)
}

/** Reads the cookie's session. Rejects (status 401) when nobody is signed in. */
export async function restore() {
  try {
    const next = await request<Session | { authenticated: false }>(SESSION_PATH)
    if (!next.authenticated) {
      set(null)
      throw Object.assign(new Error('请先登录。'), { status: 401 })
    }
    set(next)
  } finally {
    state.pending = false
  }
}

export async function signInWithPassphrase(credential: string) {
  await request(SESSION_PATH, { credential })
  await restore()
}

/** A TokensAPI account: its user id and an access token from its own settings; never stored. */
export async function signInWithTokensApi(userId: number, accessToken: string) {
  await request(SESSION_PATH, { tokensapi: true, userId, accessToken })
  await restore()
}

export async function signOut() {
  await request(SESSION_PATH, undefined, 'DELETE')
  set(null)
}

onSessionExpired(() => set(null))
