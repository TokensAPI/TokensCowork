import { vi } from 'vitest'

/** One fake /api/v1 answer: a status and a JSON body. */
export interface Reply {
  status?: number
  body: unknown
  headers?: Record<string, string>
}
export type Route = (url: string, init: RequestInit) => Reply | Promise<Reply>

/**
 * Replaces fetch with `route`, and records each call (method, path, parsed body) so a test can
 * say what the page asked the market for.
 */
export function fakeMarket(route: Route) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const reply = await route(path, init)
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...reply.headers } })
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch }
}

/** A promise and the hands that settle it, for answers that arrive out of order. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Lets pending promises and Vue's re-render run. */
export const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0))
}
