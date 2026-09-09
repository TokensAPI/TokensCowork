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
