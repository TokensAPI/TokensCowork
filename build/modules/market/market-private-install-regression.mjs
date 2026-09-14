// Real pnpm + patched market handler + SQLite ACL, isolated localhost fixture.
// The fixture Key is never sent to the production service. No plugin code runs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createD1Database } from '../../../market/server/runtime/adapters.mjs'
import { fingerprint } from '../../../market/server/security/key-fingerprint.js'
import { patchRegistryRoutes } from './market-routing-overlay.mjs'
import { MarketInstallService, createMarketPackageVerifier } from '../../../.build/desktop/dsh-community-market/lib/install/service.js'
const originalFetch = globalThis.fetch
const name = '@tokensapi/dsh-plugin-check', id = 'qa-restricted', key = 'sk-local-regression-fixture'
const root = await mkdtemp(join(tmpdir(), 'cowork-private-regression-'))
const db = createD1Database(':memory:', fileURLToPath(new URL('../../../market/server/database/migrations/', import.meta.url)))
const routeFile = new URL('../../../market/server/private-registry/routes.js', import.meta.url)
const source = patchRegistryRoutes(await readFile(routeFile, 'utf8')).replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path, routeFile).href}'`)
const { registryRoute } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const env = { MARKET_DB: db, MARKET_HMAC_SECRET: 'fixture-secret', MARKET_PRIVATE_REGISTRY_ENABLED: 'true', MARKET_PRIVATE_REGISTRY_URL: 'https://registry.fixture/', MARKET_PRIVATE_REGISTRY_TOKEN: 'fixture-service' }
const metaResponse = await originalFetch('https://market.tokensapi.ai/registry/tokens-plugin-check/' + encodeURIComponent(name), { signal: AbortSignal.timeout(45000) })
assert.equal(metaResponse.status, 200)
const metadata = await metaResponse.json()
const selected = metadata.versions[metadata['dist-tags'].latest]
const archiveResponse = await originalFetch(selected.dist.tarball, { signal: AbortSignal.timeout(45000) })
assert.equal(archiveResponse.status, 200)
const bytes = new Uint8Array(await archiveResponse.arrayBuffer())
const fixture = { ...metadata, versions: { [selected.version]: { ...selected, dist: { ...selected.dist, tarball: 'https://registry.fixture/package.tgz' } } } }
globalThis.fetch = async (url, options) => {
  if (new URL(url).origin !== 'https://registry.fixture') return originalFetch(url, options)
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-service')
  return String(url).endsWith('.tgz') ? new Response(bytes) : Response.json(fixture)
}
await db.prepare('INSERT INTO market_plugins(id,visibility,metadata) VALUES(?,?,?)').bind(id, 'restricted', JSON.stringify({ npm: true, registry: 'tokenscowork', package: name })).run()
await db.prepare('INSERT INTO market_catalog(id,state) VALUES(?,?)').bind(id, 'published').run()
await db.prepare('INSERT INTO market_org_policies(plugin_id) VALUES(?)').bind(id).run()
await db.prepare('INSERT INTO market_plugin_key_grants(plugin_id,fingerprint) VALUES(?,?)').bind(id, await fingerprint(key, env.MARKET_HMAC_SECRET)).run()
const seen = []
const server = createServer(async (req, res) => {
  try {
    const response = await registryRoute(new Request('http://' + req.headers.host + req.url, { headers: req.headers, method: req.method }), env)
    seen.push({ path: req.url, status: response.status, authenticated: req.headers.authorization === 'Bearer ' + key })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch { res.writeHead(500); res.end('fixture failure') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
try {
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const http = { getJson: async (url, signal) => {
    assert.equal(new URL(url).origin, origin)
    const response = await originalFetch(url, { headers: { authorization: 'Bearer ' + key }, signal, redirect: 'error' })
    if (!response.ok) throw Error('HTTP ' + response.status)
    return { value: await response.json(), finalUrl: response.url }
  } }
  const pnpm = fileURLToPath(new URL('../../../.build/desktop/dsh-plugin-desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  const runner = { run(args) {
    const child = spawn(process.execPath, [pnpm, ...args, '--store-dir=' + join(root, 'store'), '--cache-dir=' + join(root, 'cache'), '--ignore-scripts', '--fetch-retries=0'], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    return { stdout: child.stdout, stderr: child.stderr, done: new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (exitCode, signal) => resolve({ exitCode, signal })) }), cancel: () => child.kill() }
  } }
  const service = new MarketInstallService(() => ({ name: 'qa', dir: root }), runner, createMarketPackageVerifier(http, { privateRegistryOrigin: origin }), { registryOrigin: origin, registryToken: async () => key })
  service.observeCatalog({ schemaVersion: '1.0.0', source: { sourceRecordId: 'qa', providerId: 'qa', adapterId: 'https-json', registrationKind: 'built-in', fetchedAt: new Date().toISOString(), finalUrl: origin + '/v1/plugins' }, items: [{ id, name, displayName: 'QA', summary: 'QA', package: { registry: 'tokenscowork', name }, provenance: { sourceRecordId: 'qa', providerId: 'qa', itemId: id } }], page: {} })
  const signal = AbortSignal.timeout(180000)
  const preview = await service.previewInstall('qa', id, signal)
  await service.executeInstall(preview.intent, signal)
  assert.equal(JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version, selected.version)
  assert.ok(seen.some(r => r.path.startsWith('/registry/by-package/') && r.authenticated && r.status === 200))
  assert.ok(seen.some(r => r.path.endsWith('/tarball') && r.authenticated && r.status === 200), 'pnpm must send the Key to the actual tarball route')
  await db.prepare('DELETE FROM market_plugin_key_grants WHERE plugin_id=?').bind(id).run()
  const tarballPath = seen.find(r => r.path.endsWith('/tarball')).path
  assert.equal((await originalFetch(origin + tarballPath, { headers: { authorization: 'Bearer ' + key } })).status, 403)
  assert.equal((await originalFetch(origin + '/registry/by-package/' + encodeURIComponent(name))).status, 403)
  console.log('PASS private pnpm metadata + tarball authorization + revoked download; no plugin execution')
  await writeFile(join(root, 'results.json'), JSON.stringify({ status: 'pass', seen }, null, 2))
  console.log('Evidence', join(root, 'results.json'))
} catch (error) { console.error(String(error.details || error.stack).replaceAll(key, '[redacted]')); process.exitCode = 1 }
finally { await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch; db.close() }
