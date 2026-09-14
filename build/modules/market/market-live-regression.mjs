// Opt-in, read-only production probes + real installs in a NEW temporary Profile.
// Never publishes packages, changes production ACLs, or uses the user's Profile.
// Run from the staged Desktop workspace: yarn node ../../../build/modules/market/market-live-regression.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { MarketInstallService, createMarketPackageVerifier } from '../../../.build/desktop/dsh-community-market/lib/install/service.js'

const origin = 'https://market.tokensapi.ai'
const legacy = 'https://tokenscowork-market.pages.dev'
const dir = await mkdtemp(join(tmpdir(), 'cowork-market-regression-'))
const pnpm = fileURLToPath(new URL('../../../.build/desktop/dsh-plugin-desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
const results = []
const scrub = value => String(value).replace(/sk-[\w-]+/g, '[redacted]').replace(/(_authToken=)\S+/g, '$1[redacted]')
async function check(name, work) {
  try { await work(); results.push({ name, status: 'pass' }); console.log('PASS', name) }
  catch (error) { results.push({ name, status: 'fail', error: scrub(error.details || error.stack || error) }); console.log('FAIL', name, scrub(error.details || error.message)) }
}
async function get(url, headers = {}) {
  return fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(45000) })
}
const capability = { 'x-dsh-catalog-registries': 'npm tokenscowork' }
let items = []
await check('modern catalog', async () => {
  const response = await get(origin + '/v1/plugins', capability)
  assert.equal(response.status, 200)
  items = (await response.json()).items.filter(item => item.package?.registry === 'tokenscowork')
  assert.ok(items.length > 0)
})
await check('legacy source and capability compatibility', async () => {
  for (const base of [origin, legacy]) {
    assert.equal((await get(base + '/source.json')).status, 200)
    const modern = await get(base + '/v1/plugins', capability)
    assert.equal(modern.status, 200)
    assert.deepEqual((await modern.json()).items.filter(i => i.package?.registry === 'tokenscowork').map(i => i.id).sort(), items.map(i => i.id).sort())
    const old = await get(base + '/v1/plugins')
    assert.equal(old.status, 200)
    assert.ok((await old.json()).items.every(i => !i.package || i.package.registry === 'npm'))
  }
})
for (const item of items) await check('metadata + tarball integrity: ' + item.id, async () => {
  for (const base of [origin, legacy]) {
    const name = encodeURIComponent(item.package.name)
    const direct = await get(`${base}/registry/${item.id}/${name}`)
    const shared = await get(`${base}/registry/by-package/${name}`)
    assert.equal(direct.status, 200)
    assert.equal(shared.status, 200)
    const metadata = await shared.json()
    const version = metadata['dist-tags'].latest
    assert.equal(version, (await direct.json())['dist-tags'].latest)
    const dist = metadata.versions[version].dist
    assert.equal(new URL(dist.tarball).origin, base)
    assert.ok(new URL(dist.tarball).pathname.startsWith(`/registry/${item.id}/`))
    const archive = await get(dist.tarball)
    assert.equal(archive.status, 200)
    const bytes = Buffer.from(await archive.arrayBuffer())
    assert.ok(bytes.length > 100)
    assert.equal(createHash('sha1').update(bytes).digest('hex'), dist.shasum)
  }
  assert.equal((await get('https://npm.tokensapi.ai/' + encodeURIComponent(item.package.name))).status, 401)
})
await check('unknown and cross-plugin routes fail closed', async () => {
  assert.equal((await get(origin + '/registry/by-package/%40tokensapi%2Fqa-does-not-exist')).status, 403)
  if (items.length > 1) assert.equal((await get(`${origin}/registry/${items[0].id}/${encodeURIComponent(items[1].package.name)}`)).status, 403)
})

await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'isolated-market-regression', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
// Do not execute downloaded plugin code; test package transport and registration only.
await writeFile(join(dir, '.npmrc'), 'auto-install-peers=false\nignore-scripts=true\n')
await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const http = { getJson: async (url, signal) => {
  assert.equal(new URL(url).origin, origin)
  const r = await fetch(url, { signal, redirect: 'error' })
  if (!r.ok) throw Error('HTTP ' + r.status)
  return { value: await r.json(), finalUrl: r.url }
} }
const runner = { run(args) {
  console.log('RUN', scrub(args.join(' ')))
  const child = spawn(process.execPath, [pnpm, ...args,
    '--store-dir=' + join(dir, 'store'), '--cache-dir=' + join(dir, 'cache'),
    ...(args[0] === 'add' ? ['--ignore-scripts', '--fetch-retries=0', '--fetch-timeout=45000'] : [])], { cwd: dir, env: { ...process.env, NODE_OPTIONS: '', NPM_CONFIG_USERCONFIG: join(dir, '.npmrc') }, stdio: ['ignore', 'pipe', 'pipe'] })
  return { stdout: child.stdout, stderr: child.stderr, done: new Promise((resolve, reject) => {
    child.on('error', reject); child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  }), cancel: () => child.kill() }
} }
const service = new MarketInstallService(() => ({ name: 'isolated-market-regression', dir }), runner, createMarketPackageVerifier(http, { privateRegistryOrigin: origin }), { registryOrigin: origin, registryToken: async () => '' })
const source = { sourceRecordId: 'qa', providerId: 'com.tokensapi.plugins', adapterId: 'https-json', registrationKind: 'built-in', fetchedAt: new Date().toISOString(), finalUrl: origin + '/v1/plugins' }
service.observeCatalog({ schemaVersion: '1.0.0', source, items: items.map(item => ({ ...item, provenance: { sourceRecordId: 'qa', providerId: source.providerId, itemId: item.id } })), page: {} })
const installed = []
for (const item of items) await check('sequential real install: ' + item.id, async () => {
  const signal = AbortSignal.timeout(240000)
  const preview = await service.previewInstall('qa', item.id, signal)
  await service.executeInstall(preview.intent, signal)
  const manifest = JSON.parse(await readFile(join(dir, 'node_modules', item.package.name, 'package.json'), 'utf8'))
  assert.equal(manifest.version, preview.version)
  const profile = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes(item.package.name))
  installed.push(item)
})
await check('check updates preserves private routing', async () => {
  assert.ok(installed.length > 1, 'requires multiple installed plugins')
  const views = installed.map(i => ({ packageName: i.package.name, action: 'uninstall' }))
  const targets = new Map(installed.map(i => [i.package.name, { packageRegistry: 'tokenscowork', itemId: i.id }]))
  const statuses = await service.checkUpdates(views, targets, AbortSignal.timeout(120000))
  assert.ok(statuses.every(i => i.updateStatus === 'current'), JSON.stringify(statuses))
})
await check('real older-to-latest update preserves other plugins and bundle registration', async () => {
  const item = installed.find(i => i.id === 'tokens-plugin-check')
  assert.ok(item, 'requires installed plugin-check')
  const response = await get(origin + '/registry/' + item.id + '/' + encodeURIComponent(item.package.name))
  const metadata = await response.json()
  const latest = metadata['dist-tags'].latest
  const old = Object.keys(metadata.versions).filter(v => /^\d+\.\d+\.\d+$/.test(v) && v !== latest).sort((a,b) => {
    const av=a.split('.').map(Number),bv=b.split('.').map(Number)
    return av[0]-bv[0] || av[1]-bv[1] || av[2]-bv[2]
  })[0]
  assert.ok(old, 'requires an older published version')
  const before = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const signal = AbortSignal.timeout(240000)
  const handle = runner.run(['add', '--save-exact', '--registry=https://registry.npmjs.org/', '--@tokensapi:registry=' + origin + '/registry/by-package/', item.package.name + '@' + old])
  handle.stdout.resume(); handle.stderr.resume()
  const timer = setTimeout(() => handle.cancel(), 180000)
  try { assert.equal((await handle.done).exitCode, 0) } finally { clearTimeout(timer) }
  const preview = await service.previewUpdate(item.package.name, signal, async () => {}, { packageRegistry: 'tokenscowork', itemId: item.id })
  assert.equal(preview.updateFrom, old)
  await service.executeUpdate(preview.intent, signal)
  const after = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(after.dependencies, before.dependencies)
  assert.deepEqual(after.dsh.profile.bundles, before.dsh.profile.bundles)
  assert.equal(JSON.parse(await readFile(join(dir, 'node_modules', item.package.name, 'package.json'), 'utf8')).version, latest)
})
for (const item of installed) await check('real uninstall preserves remaining plugins: ' + item.id, async () => {
  const signal = AbortSignal.timeout(180000)
  const preview = await service.previewUninstallPackage(item.package.name, signal)
  await service.executeUninstall(preview.intent, signal)
  const profile = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.ok(!profile.dependencies?.[item.package.name])
  assert.ok(!profile.dsh.profile.bundles.includes(item.package.name))
})
await writeFile(join(dir, 'results.json'), JSON.stringify({ date: new Date().toISOString(), dir, results }, null, 2))
console.log('RESULT', JSON.stringify({ passed: results.filter(i => i.status === 'pass').length, failed: results.filter(i => i.status === 'fail').length, evidence: join(dir, 'results.json') }))
process.exitCode = results.some(i => i.status === 'fail') ? 1 : 0
