/**
 * The console's one way to call /api/v1: same-origin, bounded, never retried automatically, with
 * the market's own error text. A
 * request with data is a PUT unless another method is named; a DELETE may carry no data.
 *
 * A 401 on anything but the session itself means the sign-in has expired: the registered handler
 * (the session, see session.ts) puts the console back on the sign-in page, and the error says so.
 */
export class ApiError extends Error {
  readonly status: number
  readonly retryAfter: number | null

  constructor(message: string, status = 0, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

export const SESSION_PATH = '/api/v1/session'
const TIMEOUT_MS = 25000

let expired: () => void = () => {}
/** Called once by the session: what a 401 does to the console. */
export function onSessionExpired(handler: () => void) {
  expired = handler
}

export type Method = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'

export async function request<T = unknown>(path: string, data?: unknown, method: Method = data === undefined ? 'GET' : 'PUT'): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const mutation = data !== undefined
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: mutation ? { 'content-type': 'application/json' } : {},
      ...(mutation ? { body: JSON.stringify(data) } : {}),
    })
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new ApiError('服务返回了无效响应，请稍后刷新重试。', response.status)
    }
    if (!response.ok) {
      const reported = (value as { error?: unknown } | null)?.error
      const error = new ApiError(typeof reported === 'string' ? reported : '请求失败，请稍后重试。', response.status,
        Number(response.headers.get('retry-after')) || null)
      if (error.status === 401 && path !== SESSION_PATH) {
        expired()
        throw new ApiError('登录已过期，请重新登录。', 401)
      }
      throw error
    }
    return value as T
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError('请求超时。若刚才正在保存，请先刷新核对结果，再决定是否重试。')
    if (error instanceof TypeError) throw new ApiError('网络连接失败，请检查网络后重试。')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** How an error is told to the operator: the message, and when to try again if the market said. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const wait = error instanceof ApiError && error.retryAfter ? `（约 ${error.retryAfter} 秒后可重试）` : ''
  return message + wait
}
