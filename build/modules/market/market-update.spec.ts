import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketInstallService, type MarketPluginManager } from '../src/install/service.js'
import { DefaultCatalogService, type CatalogFullIndex } from '../src/catalog/service.js'
import { registerMarketRoutes, marketRoutes } from '../src/host/routes.js'

const temporary: string[] = []
const packageName = '@tokensapi/update-fixture'
const signal = () => new AbortController().signal
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** One community bundle as the official manager reports it. */
function bundle(overrides: Partial<BundleInfo> = {}): BundleInfo {
  return {
    name: packageName,
    official: false,
    availability: 'profile',
    version: '1.9.0',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [{ rowId: 'fixture-row', moduleName: packageName, entryId: 'entry-1' as never }],
    overrides: [],
    ...overrides,
  }
}

const applied = (stage: ChangeResult['stage'], extra: Partial<ChangeResult> = {}): ChangeResult =>
  ({ changed: true, application: 'applied', stage, target: packageName, ...extra })

/**
 * In-memory plugin manager plus a temporary profile. The service writes its
 * per-operation `.npmrc` into that directory, so every call also records
 * whether the file was in place while the manager ran.
 */
async function fixture(latest = '1.10.0') {
  const dir = await mkdtemp(join(tmpdir(), 'market-update-'))
  temporary.push(dir)
  const npmrc = join(dir, '.npmrc')
  /** Whether the product pnpm configuration was in place for each manager call. */
  const configured: boolean[] = []
  let current: BundleInfo | undefined = bundle()
  const record = () => { configured.push(existsSync(npmrc)) }
  const manager: MarketPluginManager = {
    listBundles: vi.fn(async () => current === undefined ? [] : [current]),
    listPlugins: vi.fn(async () => [{ entryId: 'entry-1' as never, fiberPhase: 'active' as never }] as never),
    installBundle: vi.fn(async (spec: string) => {
      record()
      current = bundle({ version: spec.slice(packageName.length + 1) })
      return applied('install', { bundle: packageName, version: current.version })
    }),
    setBundleEnabled: vi.fn(async () => applied('enable')),
    removeBundle: vi.fn(async () => {
      record()
      current = undefined
      return applied('remove')
    }),
  }
  const verify = vi.fn(async () => ({ version: latest }))
  let profile = { name: 'fixture', dir }
  const service = new MarketInstallService(() => profile, manager, { verify })
  const authorize = vi.fn(async (_signal: AbortSignal) => undefined)
  return {
    service, manager, verify, authorize, dir, npmrc, configured,
    installed: () => current,
    setInstalled: (next: BundleInfo | undefined) => { current = next },
    changeProfile: () => { profile = { ...profile, name: 'different' } },
  }
}

describe('product manual npm updates', () => {
  it('routes inventory, confirmation and execution through fresh authorization and immutable guards', async () => {
    const f = await fixture()
    f.setInstalled(bundle())
    let visible = true
    const scan = vi.spyOn(DefaultCatalogService.prototype, 'scanCatalog').mockImplementation(async () => ({
      snapshots: [{ items: visible ? [{ id: 'fixture-item', package: { registry: 'npm', name: packageName } }] : [] }],
    }) as unknown as CatalogFullIndex)
    type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    const handlers = new Map<string, Handler>()
    const ctx = { webServer: { port: 43120, register: (route: { path: string; handler: Handler }) => {
      handlers.set(route.path, route.handler)
      return () => {}
    } } }
    const scope = { get: () => ({ sources: [] }), update: async () => {} }
    const dispose = registerMarketRoutes(ctx as never, scope as never, { get: () => f.service }, undefined)
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
      const inventory = await request(`${marketRoutes.installations}?updates=1`)
      expect(inventory.body.installations[0]).toMatchObject({ version: '1.9.0', updateVersion: '1.10.0', updateStatus: 'available' })
      expect(scan).toHaveBeenLastCalledWith(expect.any(AbortSignal), { force: true })
      // A package name the Renderer did not take from the Host inventory is refused,
      // and so is an extra field smuggled alongside it.
      expect((await request(marketRoutes.operationPreview, { action: 'update', packageName: 'dsh-plugin-desktop' })).status).toBe(404)
      expect((await request(marketRoutes.operationPreview, { action: 'update', packageName, extra: 'injected' })).status).toBe(400)
      const preview = await request(marketRoutes.operationPreview, { action: 'update', packageName })
      expect(preview.status).toBe(200)
      expect(preview.body).toMatchObject({ action: 'update', updateFrom: '1.9.0', version: '1.10.0' })
      // Authorization is rechecked at execution: a plugin the organization no
      // longer offers is not updated, and nothing is removed.
      visible = false
      const execute = await request(marketRoutes.operationExecute, { previewId: preview.body.previewId })
      expect(execute.status).toBe(404)
      expect(f.manager.removeBundle).not.toHaveBeenCalled()
      expect(f.manager.installBundle).not.toHaveBeenCalled()
      scan.mockRejectedValue(new Error('catalog offline'))
      const offline = await request(`${marketRoutes.installations}?updates=1`)
      expect(offline.status).toBe(200)
      expect(offline.body.installations[0].updateStatus).toBe('failed')
    } finally { dispose() }
  })

  it('compares semantic versions and leaves bundles it cannot remove untouched', async () => {
    const f = await fixture()
    const locked = bundle({ name: 'dsh-plugin-locked', removable: false, readOnlyReason: 'management' as never })
    f.setInstalled(bundle())
    const views = await f.service.listInstallations(signal())
    const checked = await f.service.checkUpdates(
      [...views, { kind: 'profile', packageName: locked.name, enabled: true, installed: true, toggleable: false, removable: false }],
      new Set([packageName]), signal(),
    )
    expect(checked[0]).toMatchObject({ version: '1.9.0', updateVersion: '1.10.0', updateStatus: 'available' })
    expect(checked[1]).toMatchObject({ packageName: locked.name, updateStatus: 'unavailable' })
    expect(f.verify).toHaveBeenCalledTimes(1)
  })

  it.each(['1.9.0', '1.8.0'])('does not offer same-version installs or downgrades to %s', async latest => {
    const f = await fixture(latest)
    const views = await f.service.listInstallations(signal())
    expect((await f.service.checkUpdates(views, new Set([packageName]), signal()))[0]?.updateStatus).toBe('current')
    await expect(f.service.previewUpdate(packageName, signal(), f.authorize)).rejects.toMatchObject({ code: 'conflict' })
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
  })

  it('does not probe the registry for plugins outside the authorized catalog', async () => {
    const f = await fixture()
    const views = await f.service.listInstallations(signal())
    expect((await f.service.checkUpdates(views, new Set(), signal()))[0]?.updateStatus).toBe('unavailable')
    expect(f.verify).not.toHaveBeenCalled()
  })

  it('reports registry failure instead of claiming up to date', async () => {
    const f = await fixture()
    f.verify.mockRejectedValue(new Error('offline'))
    const views = await f.service.listInstallations(signal())
    expect((await f.service.checkUpdates(views, new Set([packageName]), signal()))[0]?.updateStatus).toBe('failed')
  })

  it('refuses a bundle whose version the official manager cannot report', async () => {
    const f = await fixture()
    f.setInstalled(bundle({ version: undefined }))
    const views = await f.service.listInstallations(signal())
    expect((await f.service.checkUpdates(views, new Set([packageName]), signal()))[0]?.updateStatus).toBe('unavailable')
    await expect(f.service.previewUpdate(packageName, signal(), f.authorize)).rejects.toMatchObject({ code: 'not-available' })
  })

  it('removes the installed package first, then installs the new version with the selection kept', async () => {
    const f = await fixture()
    f.setInstalled(bundle({ enabled: false }))
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    expect(preview).toMatchObject({ action: 'update', version: '1.10.0', updateFrom: '1.9.0' })
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
    const result = await f.service.executePreview(preview.intent, signal())
    expect(result).toMatchObject({ action: 'update', version: '1.10.0', application: 'applied' })
    // Upstream's own update semantics: remove, then install over it.
    expect(vi.mocked(f.manager.removeBundle).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(f.manager.installBundle).mock.invocationCallOrder[0]!)
    expect(f.manager.installBundle).toHaveBeenCalledWith(`${packageName}@1.10.0`,
      expect.objectContaining({ enabled: false, saveExact: true }))
    // Both steps ran with the product pnpm configuration in place, and it is gone now.
    expect(f.configured).toEqual([true, true])
    expect(existsSync(f.npmrc)).toBe(false)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'intent-expired' })
  })

  it('rejects a changed installed version between confirmation and execution', async () => {
    const f = await fixture()
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    f.setInstalled(bundle({ version: '1.9.1' }))
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'conflict' })
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
  })

  it('rechecks organization authorization before writing', async () => {
    const f = await fixture()
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    f.authorize.mockRejectedValue(new Error('access revoked'))
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toThrow('access revoked')
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
  })

  it('rejects a profile switch or disposed host', async () => {
    const f = await fixture()
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    f.changeProfile()
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'conflict' })
    f.service.dispose()
    await expect(f.service.previewUpdate(packageName, signal(), f.authorize)).rejects.toMatchObject({ code: 'operation-failed' })
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
  })

  it('keeps the plugin when the removal fails and says the plugin is gone when the install fails', async () => {
    const kept = await fixture()
    vi.mocked(kept.manager.removeBundle).mockResolvedValue({
      changed: false, application: 'failed', stage: 'remove', target: packageName,
      packageResult: { exitCode: 1, output: 'remove failed', truncated: false, logPath: '/tmp/log' } as never,
    })
    const first = await kept.service.previewUpdate(packageName, signal(), kept.authorize)
    await expect(kept.service.executePreview(first.intent, signal())).rejects.toMatchObject({
      code: 'operation-failed',
      message: expect.stringContaining('nothing changed'),
    })
    expect(kept.manager.installBundle).not.toHaveBeenCalled()
    expect(existsSync(kept.npmrc)).toBe(false)

    const lost = await fixture()
    vi.mocked(lost.manager.installBundle).mockResolvedValue({
      changed: false, application: 'failed', stage: 'install', target: packageName,
      packageResult: { exitCode: 1, output: 'install failed', truncated: false, logPath: '/tmp/log' } as never,
    })
    const second = await lost.service.previewUpdate(packageName, signal(), lost.authorize)
    await expect(lost.service.executePreview(second.intent, signal())).rejects.toMatchObject({
      code: 'operation-failed',
      message: expect.stringContaining('Install the plugin again'),
    })
    expect(lost.manager.removeBundle).toHaveBeenCalledTimes(1)
    expect(existsSync(lost.npmrc)).toBe(false)
  })

  it('reports a timed-out package run as a download timeout', async () => {
    const f = await fixture()
    vi.mocked(f.manager.removeBundle).mockResolvedValue({
      changed: false, application: 'failed', stage: 'remove', target: packageName,
      packageResult: { exitCode: 1, output: 'timed out', truncated: false, logPath: '/tmp/log', kind: 'timeout' } as never,
    })
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'operation-timeout' })
  })

  it('leaves a profile .npmrc the user wrote alone and refuses the operation', async () => {
    const f = await fixture()
    const mine = 'registry=https://my-mirror.example/\n'
    await writeFile(f.npmrc, mine)
    const preview = await f.service.previewUpdate(packageName, signal(), f.authorize)
    await expect(f.service.executePreview(preview.intent, signal())).rejects.toMatchObject({ code: 'conflict' })
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
    expect(await readFile(f.npmrc, 'utf8')).toBe(mine)
  })
})
