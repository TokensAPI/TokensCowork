import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistryClient } from './client.mjs'
test('private registry is disabled without configuration', async () => {
  const client = createRegistryClient({}, () => { throw Error('must not fetch') })
  assert.deepEqual(client.status(), { enabled: false, ready: false })
  assert.deepEqual(await client.metadata('@fixture/plugin'), { ok: false, reason: 'disabled' })
})
test('configured registry uses standard npm metadata without fallback', async () => {
  const client = createRegistryClient({ MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example.test/npm/', MARKET_PRIVATE_REGISTRY_TOKEN: 'fixture-token' }, async (url, options) => {
    assert.equal(String(url), 'https://registry.example.test/npm/%40fixture%2Fplugin')
    assert.equal(options.headers.Authorization, 'Bearer fixture-token')
    return Response.json({ name: '@fixture/plugin', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: '@fixture/plugin', version: '1.0.0', dist: { tarball: 'https://registry.example.test/npm/@fixture/plugin/-/plugin-1.0.0.tgz' } } } })
  })
  const result = await client.resolve('@fixture/plugin')
  assert.equal(result.ok, true)
  assert.equal(result.version, '1.0.0')
})
test('private registry rejects invalid tarball redirects and exposes stable latest only', async () => {
  const client = createRegistryClient({ MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example.test/', MARKET_PRIVATE_REGISTRY_TOKEN: 'fixture-token' }, async () => Response.json({ name: 'fixture', 'dist-tags': { latest: '1.1.0-beta.1' }, versions: { '1.1.0-beta.1': { name: 'fixture', version: '1.1.0-beta.1', dist: { tarball: 'https://registry.example.test/fixture.tgz' } } } }))
  const result = await client.resolve('fixture')
  assert.equal(result.ok, true)
  assert.equal(result.stable, false)
  assert.deepEqual(await client.tarball('https://cdn.example.test/fixture.tgz'), { ok: false, reason: 'invalid-url' })
})
const registryEnv = {
  MARKET_PRIVATE_REGISTRY_ENABLED: 'true',
  MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example.test/',
  MARKET_PRIVATE_REGISTRY_TOKEN: 'fixture-token',
  MARKET_PRIVATE_REGISTRY_TARBALL_TIMEOUT_MS: '1000',
}

test('an archive streams through, and its deadline covers only the response headers', async () => {
  const pending = ['fix', 'ture', '-arch', 'ive']
  const client = createRegistryClient(registryEnv, async (url, options) => {
    assert.equal(options.headers.Accept, 'application/octet-stream')
    assert.equal(options.headers.Authorization, 'Bearer fixture-token')
    return new Response(new ReadableStream({
      // Delivering the body outlasts the header deadline on purpose, and it
      // fails the way fetch does if that deadline is still armed.
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 300))
        if (options.signal.aborted) return controller.error(new Error('aborted mid-body'))
        const chunk = pending.shift()
        return chunk === undefined ? controller.close() : controller.enqueue(new TextEncoder().encode(chunk))
      },
    }), { headers: { 'content-type': 'application/octet-stream', 'content-length': '15' } })
  })
  const result = await client.tarball('https://registry.example.test/fixture.tgz')
  assert.equal(result.ok, true)
  assert.equal(result.contentType, 'application/octet-stream')
  assert.equal(result.contentLength, 15)
  assert.equal(result.bytes, undefined, 'the archive must not be buffered in the worker')
  let text = ''
  for await (const chunk of result.body) text += new TextDecoder().decode(chunk)
  assert.equal(text, 'fixture-archive')

  // An undeclared length stays undeclared instead of becoming zero.
  const chunked = createRegistryClient(registryEnv, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('fixture-archive')); controller.close() },
  })))
  assert.equal((await chunked.tarball('https://registry.example.test/fixture.tgz')).contentLength, undefined)
})

test('an archive whose headers never arrive, or that upstream refuses, never reaches the client', async () => {
  const stalled = createRegistryClient(registryEnv, (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted before headers')))
  }))
  assert.deepEqual(await stalled.tarball('https://registry.example.test/fixture.tgz'), { ok: false, reason: 'registry-unavailable' })
  for (const [status, reason] of [[404, 'not-found'], [500, 'registry-unavailable'], [302, 'registry-unavailable']]) {
    const client = createRegistryClient(registryEnv, async () => new Response('nope', { status }))
    assert.deepEqual(await client.tarball('https://registry.example.test/fixture.tgz'), { ok: false, reason })
  }
})

test('the buffered archive read is bounded and gives a stalled body a deadline', async () => {
  // Only the catalog's locale lookup buffers an archive; it keeps the ordinary
  // request budget because no installing client is waiting on it.
  const bufferedEnv = { ...registryEnv, MARKET_PRIVATE_REGISTRY_TIMEOUT_MS: '1000' }
  const complete = () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of ['fix', 'ture', '-archive']) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  }))
  const client = createRegistryClient(bufferedEnv, async () => complete())
  const result = await client.tarballBytes('https://registry.example.test/fixture.tgz')
  assert.equal(result.ok, true)
  assert.equal(new TextDecoder().decode(result.bytes), 'fixture-archive')

  // An archive past the cap is refused rather than filling the worker's memory.
  const oversize = createRegistryClient(bufferedEnv, async () => complete())
  assert.deepEqual(await oversize.tarballBytes('https://registry.example.test/fixture.tgz', 4),
    { ok: false, reason: 'response-too-large' })

  // A body that stops arriving is an outage, never a half-read archive.
  const stalled = createRegistryClient(bufferedEnv, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('fixture')) },
  })))
  assert.deepEqual(await stalled.tarballBytes('https://registry.example.test/fixture.tgz'),
    { ok: false, reason: 'registry-unavailable' })
})

test('basic scheme sends the service account instead of an expiring bearer token', async () => {
  const client = createRegistryClient({ MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example.test/', MARKET_PRIVATE_REGISTRY_TOKEN: 'market:s3cret', MARKET_PRIVATE_REGISTRY_AUTH_SCHEME: 'basic' }, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('market:s3cret'))
    return Response.json({ name: 'fixture', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'fixture', version: '1.0.0', dist: { tarball: 'https://registry.example.test/fixture.tgz' } } } })
  })
  assert.equal((await client.resolve('fixture')).ok, true)
})
test('malformed credentials and unknown schemes never reach the network', async () => {
  const base = { MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example.test/' }
  const reject = () => { throw Error('must not fetch') }
  for (const [env, reason] of [
    [{ ...base, MARKET_PRIVATE_REGISTRY_TOKEN: 'market', MARKET_PRIVATE_REGISTRY_AUTH_SCHEME: 'basic' }, 'invalid-credentials'],
    [{ ...base, MARKET_PRIVATE_REGISTRY_TOKEN: 'market:', MARKET_PRIVATE_REGISTRY_AUTH_SCHEME: 'basic' }, 'invalid-credentials'],
    [{ ...base, MARKET_PRIVATE_REGISTRY_TOKEN: 'market:密码', MARKET_PRIVATE_REGISTRY_AUTH_SCHEME: 'basic' }, 'invalid-credentials'],
    [{ ...base, MARKET_PRIVATE_REGISTRY_TOKEN: 'fixture-token', MARKET_PRIVATE_REGISTRY_AUTH_SCHEME: 'digest' }, 'invalid-auth-scheme'],
  ]) {
    const client = createRegistryClient(env, reject)
    assert.deepEqual(client.status(), { enabled: true, ready: false, reason })
    assert.deepEqual(await client.metadata('fixture'), { ok: false, reason })
  }
})
