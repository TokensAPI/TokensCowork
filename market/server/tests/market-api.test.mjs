import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketRequest } from '../admin/assets/market-api.js'

test('GET requests include same-origin session, no-store and bounded abort signal', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/admin/access')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.signal.aborted, false)
    assert.deepEqual(options.headers, {})
    assert.equal(Object.hasOwn(options, 'body'), false)
    return Response.json({ plugins: [] })
  })
  assert.deepEqual(await marketRequest('/api/admin/access'), { plugins: [] })
  assert.equal(fetch.mock.callCount(), 1)
})

test('defined data, including false and null, is sent as a single JSON mutation', async t => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    assert.equal(options.method, 'PUT')
    assert.deepEqual(options.headers, { 'content-type': 'application/json' })
    bodies.push(options.body)
    return Response.json({ ok: true })
  })
  for (const data of [{ enabled: false }, false, null]) await marketRequest('/api/admin/fixture', data)
  assert.deepEqual(bodies, ['{"enabled":false}', 'false', 'null'])
})

test('401 preserves the server login error and status for controller session handling', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '管理凭证无效' }, { status: 401 }))
  await assert.rejects(marketRequest('/api/admin/login', { credential: 'fixture-only-invalid-login' }), error => {
    assert.equal(error.status, 401)
    assert.equal(error.message, '管理凭证无效')
    assert.equal(error.retryAfter, null)
    return true
  })
})

test('429 exposes bounded retry advice but never retries a mutation automatically', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: '请求过于频繁，请稍后再试' },
    { status: 429, headers: { 'retry-after': '60' } },
  ))
  await assert.rejects(marketRequest('/api/admin/login', { credential: 'fixture-only-invalid-login' }), error => {
    assert.equal(error.status, 429)
    assert.equal(error.retryAfter, 60)
    assert.match(error.message, /过于频繁/u)
    return true
  })
  assert.equal(fetch.mock.callCount(), 1)
})

test('non-JSON responses expose a readable error instead of response HTML', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>upstream diagnostic fixture</html>', { status: 502 }))
  await assert.rejects(marketRequest('/api/admin/access'), error => {
    assert.equal(error.status, 502)
    assert.match(error.message, /无效响应/u)
    assert.ok(!error.message.includes('upstream diagnostic'))
    return true
  })
})

test('non-JSON 401 still retains its status so the controller can clear session data', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }))
  await assert.rejects(marketRequest('/api/admin/access'), error => error.status === 401 && /无效响应/u.test(error.message))
})

test('invalid JSON in a successful response fails visibly rather than silently succeeding', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{', { status: 200 }))
  await assert.rejects(marketRequest('/api/admin/access'), error => error.status === 200 && /无效响应/u.test(error.message))
})

test('non-string server errors use a safe generic message', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { internal: 'fixture diagnostic' } }, { status: 503 }))
  await assert.rejects(marketRequest('/api/admin/access'), error => error.status === 503 && error.message === '请求失败，请稍后重试。')
})

test('network failure is translated and a potentially applied mutation is not retried', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('private transport diagnostic fixture') })
  await assert.rejects(marketRequest('/api/admin/organizations', { id: 9, name: 'Fixture', enabled: true }), error => {
    assert.match(error.message, /网络连接失败/u)
    assert.ok(!error.message.includes('private transport'))
    return true
  })
  assert.equal(fetch.mock.callCount(), 1)
})

test('server failure after a write is returned without automatic mutation retry', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '服务暂时不可用' }, { status: 503 }))
  await assert.rejects(marketRequest('/api/admin/organizations', { id: 9, name: 'Fixture', enabled: true }), error => error.status === 503)
  assert.equal(fetch.mock.callCount(), 1)
})

test('request timeout aborts at 25 seconds and tells users to check saved state before retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const fetch = t.mock.method(globalThis, 'fetch', (_path, options) => {
    signal = options.signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  })
  const rejection = assert.rejects(marketRequest('/api/admin/organizations', { id: 9, name: 'Fixture', enabled: true }), error => {
    assert.match(error.message, /请求超时/u)
    assert.match(error.message, /刷新核对结果/u)
    return true
  })
  t.mock.timers.tick(24999)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await rejection
  assert.equal(signal.aborted, true)
  assert.equal(fetch.mock.callCount(), 1)
})

test('successful requests cancel their timeout timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    signal = options.signal
    return Response.json({ ok: true })
  })
  await marketRequest('/api/admin/access')
  t.mock.timers.tick(30000)
  assert.equal(signal.aborted, false)
})
