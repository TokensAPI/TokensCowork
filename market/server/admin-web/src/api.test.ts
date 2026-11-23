import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, errorText, onSessionExpired, request } from './api'
import { useRequest } from './useRequest'
import { deferred, fakeMarket } from './test-support'

afterEach(() => {
  vi.unstubAllGlobals()
  onSessionExpired(() => {})
})

describe('request()', () => {
  it('sends data as JSON, PUT unless told otherwise, and returns the answer', async () => {
    const { calls } = fakeMarket(() => ({ body: { ok: true } }))
    expect(await request('/api/v1/keys', { label: 'a' })).toEqual({ ok: true })
    await request('/api/v1/keys', { key: 'sk-1' }, 'POST')
    await request('/api/v1/keys/x', undefined, 'DELETE')
    expect(calls).toEqual([
      { method: 'PUT', path: '/api/v1/keys', body: { label: 'a' } },
      { method: 'POST', path: '/api/v1/keys', body: { key: 'sk-1' } },
      { method: 'DELETE', path: '/api/v1/keys/x', body: undefined },
    ])
  })

  it('reports the market\'s own error text, status and when to retry', async () => {
    fakeMarket(() => ({ status: 429, body: { error: '尝试次数过多，请稍后再试' }, headers: { 'retry-after': '30' } }))
    const error = await request('/api/v1/session', { credential: 'x' }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect([(error as ApiError).status, (error as ApiError).retryAfter]).toEqual([429, 30])
    expect(errorText(error)).toBe('尝试次数过多，请稍后再试（约 30 秒后可重试）')
  })

  it('a 401 anywhere but the session sends the console back to sign-in, and says why', async () => {
    const expired = vi.fn()
    onSessionExpired(expired)
    fakeMarket(() => ({ status: 401, body: { error: 'unauthorized' } }))
    await expect(request('/api/v1/keys')).rejects.toMatchObject({ status: 401, message: '登录已过期，请重新登录。' })
    expect(expired).toHaveBeenCalledTimes(1)
    // Asking who is signed in, or signing in with a wrong passphrase, is not an expiry.
    await expect(request('/api/v1/session', { credential: 'wrong' })).rejects.toMatchObject({ status: 401, message: 'unauthorized' })
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('reads are same-origin and never cached; a request still unanswered after 25 seconds is abandoned and says to check before retrying', async () => {
    vi.useFakeTimers()
    try {
      let seen: RequestInit = {}
      vi.stubGlobal('fetch', vi.fn((_: unknown, init: RequestInit) => {
        seen = init
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }))
      const pending = request('/api/v1/keys', { label: 'x' }, 'PATCH').catch((error: unknown) => error)
      expect([seen.credentials, seen.cache, seen.redirect]).toEqual(['same-origin', 'no-store', 'error'])
      await vi.advanceTimersByTimeAsync(25000)
      expect(((await pending) as Error).message).toBe('请求超时。若刚才正在保存，请先刷新核对结果，再决定是否重试。')
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a network failure or a page that is not JSON reads as such', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(request('/api/v1/keys')).rejects.toThrow('网络连接失败，请检查网络后重试。')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })))
    await expect(request('/api/v1/keys')).rejects.toMatchObject({ status: 502, message: '服务返回了无效响应，请稍后刷新重试。' })
  })
})

describe('useRequest()', () => {
  it('keeps only the latest answer: a slow earlier read never replaces a newer one', async () => {
    const answers = [deferred<string>(), deferred<string>()]
    let call = 0
    const read = useRequest(() => answers[call++]!.promise)
    const first = read.run()
    const second = read.run()
    expect(read.loading.value).toBe(true)
    answers[1]!.resolve('newer')
    expect(await second).toBe(true)
    expect([read.data.value, read.loading.value]).toEqual(['newer', false])
    answers[0]!.resolve('older')
    expect(await first).toBe(false)
    expect(read.data.value).toBe('newer')
  })

  it('a stale failure is dropped too; the latest one is kept and the last data stays', async () => {
    const answers = [deferred<string>(), deferred<string>(), deferred<string>()]
    let call = 0
    const read = useRequest(() => answers[call++]!.promise)
    void read.run()
    answers[0]!.resolve('first')
    await Promise.resolve()
    await Promise.resolve()
    const stale = read.run()
    const latest = read.run()
    answers[1]!.reject(new Error('stale'))
    expect(await stale).toBe(false)
    expect(read.error.value).toBeNull()
    answers[2]!.reject(new Error('latest'))
    expect(await latest).toBe(false)
    expect([read.error.value?.message, read.data.value, read.loading.value]).toEqual(['latest', 'first', false])
  })
})
