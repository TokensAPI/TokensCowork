import test from 'node:test'
import assert from 'node:assert/strict'
import { registryRoute } from './routes.js'

const id = 'tokens-dark-image-edit'
const parent = '@tokensapi/dsh-dark-image-edit'
const names = ['darwin-arm64', 'darwin-x64', 'win32-x64'].map(x => `@tokensapi/dsh-portrait-runtime-${x}`)
const dependencies = Object.fromEntries(names.map(name => [name, '0.1.0']))

function fixture(t, { granted = true, declared = true, outage = false } = {}) {
  const row = { id, state: 'published', visibility: 'restricted', metadata: JSON.stringify({ npm: true, registry: 'tokenscowork', package: parent }) }
  const calls = []
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async first() { return sql.includes('FROM market_plugins') && values[0] === id ? row : null },
    async all() {
      if (sql.includes('json_extract')) return { results: values[0] === parent ? [{ id }] : [] }
      if (sql.includes("kind='key'")) return { results: granted ? [{ plugin_id: id }] : [] }
      return { results: [] }
    },
  })
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url))
    if (outage) return new Response('', { status: 503 })
    const path = decodeURIComponent(new URL(url).pathname.slice(1))
    if (path.endsWith('.tgz')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } })
    const isParent = path === parent
    const version = isParent ? '0.1.14' : '0.1.0'
    const manifest = {
      name: path, version,
      ...(isParent ? { optionalDependencies: declared ? dependencies : {} } : { os: [path.includes('win32') ? 'win32' : 'darwin'], cpu: [path.endsWith('arm64') ? 'arm64' : 'x64'] }),
      dist: { tarball: `https://registry.example.test/${encodeURIComponent(path)}.tgz`, integrity: 'sha512-fixture' },
    }
    return Response.json({ name: path, 'dist-tags': { latest: version }, versions: { [version]: manifest, '9.0.0': { ...manifest, version: '9.0.0' } } })
  })
  const env = {
    MARKET_DB: { prepare: sql => statement(sql) }, MARKET_HMAC_SECRET: 'fixture-secret',
    ASSETS: { fetch: async () => Response.json({ items: [] }) },
    MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.example.test/',
    MARKET_PRIVATE_REGISTRY_TOKEN: 'fixture-only',
  }
  const request = path => registryRoute(new Request(`https://market.example.test/registry/${path}`, { headers: { Authorization: 'Bearer sk-fixture' } }), env)
  return { request, calls }
}

for (const name of names) test(`parent grant permits exact runtime metadata and archive: ${name}`, async t => {
  const { request } = fixture(t)
  const response = await request(`by-package/${encodeURIComponent(name)}`)
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.deepEqual(Object.keys(data.versions), ['0.1.0'])
  assert.equal(data['dist-tags'].latest, '0.1.0')
  assert.equal(data.versions['0.1.0'].cpu[0], name.endsWith('arm64') ? 'arm64' : 'x64')
  const tarball = new URL(data.versions['0.1.0'].dist.tarball)
  const archive = await request(tarball.pathname.slice('/registry/'.length))
  assert.equal(archive.status, 200)
  assert.deepEqual([...new Uint8Array(await archive.arrayBuffer())], [1, 2, 3])
})

test('runtime grant never bypasses denied parent access or contacts upstream', async t => {
  const { request, calls } = fixture(t, { granted: false })
  assert.equal((await request(`by-package/${encodeURIComponent(names[0])}`)).status, 403)
  assert.equal(calls.length, 0)
})

test('runtime versions outside the reviewed dependency are denied', async t => {
  const { request, calls } = fixture(t)
  assert.equal((await request(`${id}/${encodeURIComponent(names[0])}/9.0.0/tarball`)).status, 403)
  assert.equal(calls.length, 0)
})

test('unrelated packages remain denied without contacting upstream', async t => {
  const { request, calls } = fixture(t)
  assert.equal((await request(`by-package/${encodeURIComponent('@tokensapi/unrelated')}`)).status, 403)
  assert.equal(calls.length, 0)
})

test('allowlist requires actual exact declaration in the published parent', async t => {
  const { request } = fixture(t, { declared: false })
  assert.equal((await request(`by-package/${encodeURIComponent(names[0])}`)).status, 403)
})

test('upstream outage fails closed', async t => {
  const { request } = fixture(t, { outage: true })
  assert.equal((await request(`by-package/${encodeURIComponent(names[0])}`)).status, 503)
})

test('parent metadata still preserves all optional dependencies', async t => {
  const { request } = fixture(t)
  const response = await request(`by-package/${encodeURIComponent(parent)}`)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).versions['0.1.14'].optionalDependencies, dependencies)
})
