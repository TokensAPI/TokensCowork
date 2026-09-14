import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketInstallService, type MarketDesktopPnpm } from '../src/install/service.js'
import type { MarketInstallationView } from '../src/api-types.js'
import { DefaultCatalogService, type CatalogFullIndex } from '../src/catalog/service.js'
import { registerMarketRoutes, marketRoutes } from '../src/host/routes.js'

const temporary: string[] = []
const packageName = '@tokensapi/update-fixture'
const item: MarketInstallationView = { kind: 'profile', bundleId: 'fixture', packageName, status: 'active', action: 'uninstall' }
const signal = () => new AbortController().signal
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(latest = '1.10.0') {
  const dir = await mkdtemp(join(tmpdir(), 'market-update-'))
  temporary.push(dir)
  const packageDir = join(dir, 'node_modules', packageName)
  await mkdir(packageDir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  const packagePath = join(packageDir, 'package.json')
  const settingsPath = join(dir, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ plugin: { enabled: false, endpoint: 'preserved' } }))
  const writeVersion = async (version: string) => {
    await writeFile(manifestPath, JSON.stringify({ dependencies: { [packageName]: version }, dsh: { profile: { bundles: [packageName], custom: 'keep' } } }))
    await writeFile(packagePath, JSON.stringify({ name: packageName, version }))
  }
  await writeVersion('1.9.0')
  const run = vi.fn<MarketDesktopPnpm['run']>(argv => ({
    stdout: Readable.from([]), stderr: Readable.from([]), cancel: vi.fn(),
    done: writeVersion(argv.at(-1)!.slice(packageName.length + 1)).then(() => ({ exitCode: 0, signal: null })),
  }))
  const verify = vi.fn(async () => ({ version: latest }))
  let profile = { name: 'fixture', dir }
  const service = new MarketInstallService(() => profile, { run }, { verify })
  const authorize = vi.fn(async (_signal: AbortSignal) => {})
  return { service, run, verify, authorize, writeVersion, manifestPath, packagePath, settingsPath,
    changeProfile: () => { profile = { ...profile, name: 'different' } } }
}

describe('product manual npm updates', () => {
  it('routes inventory, confirmation and execution through fresh authorization and immutable guards', async () => {
    const f = await fixture()
    let visible = true
    const scan = vi.spyOn(DefaultCatalogService.prototype, 'scanCatalog').mockImplementation(async () => ({
      snapshots: [{ items: visible ? [{ package: { registry: 'npm', name: packageName } }] : [] }],
    }) as unknown as CatalogFullIndex)
    type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    const handlers = new Map<string, Handler>()
    const ctx = { webServer: { port: 43120, register: (route: { path: string; handler: Handler }) => {
      handlers.set(route.path, route.handler)
      return () => {}
    } } }
    const scope = { get: () => ({ sources: [] }), update: async () => {} }
    const desktop = { list: () => [
      { bundleId: 'fixture', packageName, status: 'active' as const, mutable: true, uninstallable: true },
      { bundleId: 'core', packageName: 'dsh-plugin-desktop', status: 'active' as const, mutable: false, uninstallable: false },
    ] }
    const dispose = registerMarketRoutes(ctx as never, scope as never, { get: () => f.service }, undefined, { get: () => desktop })
    const request = async (path: string, body?: unknown) => {
      const req = Object.assign(new EventEmitter(), { method: body === undefined ? 'GET' : 'POST', url: path,
        headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120', 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress: '127.0.0.1' }, destroy: vi.fn() })
      let response = ''
      const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, statusCode: 0,
        setHeader: vi.fn(), removeHeader: vi.fn(), end: (value: string) => { response = value; res.writableEnded = true } })
      const pending = handlers.get(path.split('?')[0]!)!(req as unknown as IncomingMessage, res as unknown as ServerResponse)
      if (body !== undefined) queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
      await pending
      return { status: res.statusCode, body: JSON.parse(response) }
    }
    try {
      const inventory = await request(marketRoutes.installations + '?updates=1')
      expect(inventory.body.installations[0]).toMatchObject({ version: '1.9.0', updateVersion: '1.10.0', updateStatus: 'available' })
      expect(inventory.body.installations[1].updateStatus).toBeUndefined()
      expect(scan).toHaveBeenLastCalledWith(expect.any(AbortSignal), { force: true })
      expect((await request(marketRoutes.operationPreview, { action: 'update', bundleId: 'core' })).status).toBe(404)
      expect((await request(marketRoutes.operationPreview, { action: 'update', bundleId: 'fixture', packageName: 'injected' })).status).toBe(400)
      const preview = await request(marketRoutes.operationPreview, { action: 'update', bundleId: 'fixture' })
      expect(preview.status).toBe(200)
      expect(preview.body).toMatchObject({ action: 'update', updateFrom: '1.9.0', version: '1.10.0' })
      visible = false
      const execute = await request(marketRoutes.operationExecute, { previewId: preview.body.previewId })
      expect(execute.status).toBe(404)
      expect(f.run).not.toHaveBeenCalled()
      scan.mockRejectedValue(new Error('catalog offline'))
      const offline = await request(marketRoutes.installations + '?updates=1')
      expect(offline.status).toBe(200)
      expect(offline.body.installations[0].updateStatus).toBe('failed')
    } finally { dispose() }
  })
  it('compares semantic versions and leaves system components untouched', async () => {
    const f = await fixture()
    const system = { ...item, action: 'none' as const }
    expect(await f.service.checkUpdates([item, system], new Set([packageName]), signal())).toEqual([
      { ...item, version: '1.9.0', updateVersion: '1.10.0', updateStatus: 'available' }, system,
    ])
    expect(f.verify).toHaveBeenCalledTimes(1)
  })
  it.each(['1.9.0', '1.8.0'])('does not offer same-version installs or downgrades to %s', async latest => {
    const f = await fixture(latest)
    expect((await f.service.checkUpdates([item], new Set([packageName]), signal()))[0]?.updateStatus).toBe('current')
    await expect(f.service.previewUpdate(packageName, signal(), f.authorize)).rejects.toMatchObject({ code: 'conflict' })
    expect(f.run).not.toHaveBeenCalled()
  })
  it('does not probe npm for plugins outside the authorized catalog', async () => {
    const f = await fixture()
    expect((await f.service.checkUpdates([item], new Set(), signal()))[0]?.updateStatus).toBe('unavailable')
    expect(f.verify).not.toHaveBeenCalled()
  })
  it('reports registry failure instead of claiming up to date', async () => {
    const f = await fixture()
    f.verify.mockRejectedValue(new Error('offline'))
    expect((await f.service.checkUpdates([item], new Set([packageName]), signal()))[0]?.updateStatus).toBe('failed')
  })
  it('uses actual installed metadata and rejects local/non-npm dependencies', async () => {
    const f = await fixture()
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
    manifest.dependencies[packageName] = '^1.0.0'
    await writeFile(f.manifestPath, JSON.stringify(manifest))
    expect((await f.service.checkUpdates([item], new Set([packageName]), signal()))[0]?.version).toBe('1.9.0')
    manifest.dependencies[packageName] = 'file:../local'
    await writeFile(f.manifestPath, JSON.stringify(manifest))
    await expect(f.service.previewUpdate(packageName, signal(), f.authorize)).rejects.toMatchObject({ code: 'not-available' })
  })
  it('confirms the exact upgrade, preserves settings/bundles, and returns a restart grant', async () => {
    const f = await fixture()
    const before = await readFile(f.settingsPath, 'utf8')
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    expect(preview).toMatchObject({ action: 'update', version: '1.10.0', updateFrom: '1.9.0' })
    expect(f.run).not.toHaveBeenCalled()
    const result = await f.service.executePreview(preview.intent, signal())
    expect(result).toMatchObject({ action: 'update', version: '1.10.0' })
    expect(f.run.mock.calls[0]?.[0]).toEqual(['add', '--save-exact', '--registry=https://registry.npmjs.org/', '--@tokensapi:registry=https://registry.npmjs.org/', packageName + '@1.10.0'])
    expect(await readFile(f.settingsPath, 'utf8')).toBe(before)
    expect(JSON.parse(await readFile(f.manifestPath, 'utf8')).dsh.profile).toEqual({ bundles: [packageName], custom: 'keep' })
    expect(f.authorize).toHaveBeenCalledTimes(2)
    f.service.consumeRestartToken(result.restartToken)
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'intent-expired' })
  })
  it('rejects a changed local version between confirmation and execution', async () => {
    const f = await fixture()
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    await f.writeVersion('1.9.1')
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'conflict' })
    expect(f.run).not.toHaveBeenCalled()
  })
  it('rechecks organization authorization before writing', async () => {
    const f = await fixture()
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    f.authorize.mockRejectedValue(new Error('access revoked'))
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toThrow('access revoked')
    expect(f.run).not.toHaveBeenCalled()
  })
  it('rejects a profile switch or disposed host', async () => {
    const f = await fixture()
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    f.changeProfile()
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'conflict' })
    f.service.dispose()
    await expect(f.service.previewUpdate(packageName, signal(), f.authorize)).rejects.toMatchObject({ code: 'operation-failed' })
    expect(f.run).not.toHaveBeenCalled()
  })
  it('surfaces package-manager failure without issuing a restart grant', async () => {
    const f = await fixture()
    f.run.mockImplementation(() => ({ stdout: Readable.from([]), stderr: Readable.from(['failed']), cancel: vi.fn(), done: Promise.resolve({ exitCode: 1, signal: null }) }))
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'operation-failed' })
    expect(f.run).toHaveBeenCalledTimes(1)
  })
})
