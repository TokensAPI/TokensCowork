import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { addMarketUpdates, addMarketUpdateChecks, addMarketUpdateUiTests } from './market-update-overlay.mjs'
import { pinProductMarketSource, skipUpstreamSourceDescriptionTests, allowMarketSourceSyntheticProxy } from './market-source-overlay.mjs'
import { addMarketAuth } from './market-auth-overlay.mjs'
import { addPrivateRegistrySupport } from './market-registry-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const paths = { service: 'src/install/service.ts', routes: 'src/host/routes.ts', types: 'src/api-types.ts', settingsTab: 'src/client/MarketSettingsTab.tsx', locales: 'src/client/locales.ts' }
const read = path => readFileSync(resolve(root, 'desktop/dsh-community-market', path), 'utf8').replaceAll('\r\n', '\n')
const config = JSON.parse(readFileSync(resolve(root, 'market/server/source.config.json'), 'utf8'))
const sourceManifest = JSON.parse(readFileSync(resolve(root, 'market/server/source.json'), 'utf8'))
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, read(path)]))
const pinned = pinProductMarketSource({ index: read('src/index.ts'), sourceStore: read('src/catalog/source-store.ts'), service: read('src/catalog/service.ts'), routes: sources.routes, settingsTab: sources.settingsTab, locales: sources.locales }, config.origin, sourceManifest)
const auth = addMarketAuth({ index: pinned.index, routes: pinned.routes, http: allowMarketSourceSyntheticProxy(read('src/network/restricted-http.ts'), new URL(config.origin).hostname) }, config.origin)
const installedTests = skipUpstreamSourceDescriptionTests(read('tests/market-settings-tab.spec.tsx'))
const input = { ...sources, routes: auth.routes, settingsTab: pinned.settingsTab, locales: pinned.locales }
const output = addMarketUpdates(input)

test('registry composition reuses catalog version hints without removing update verification', () => {
  const result = addPrivateRegistrySupport({
    http: auth.http, index: auth.index, service: output.service, routes: output.routes,
    identity: read('src/contracts/identity.ts'), types: read('src/contracts/types.ts'),
    providerSchema: read('docs/schemas/catalog-provider-page.schema.json'),
    snapshotSchema: read('docs/schemas/catalog-snapshot.schema.json'),
    providerTypes: read('src/contracts/generated/catalog-provider-page.ts'),
    snapshotTypes: read('src/contracts/generated/catalog-snapshot.ts'),
  }, config.origin)
  assert.match(result.routes, /latestVersion: item.latestVersion/)
  assert.match(result.service, /stableExactVersion\(target.latestVersion\)/)
  assert.match(result.service, /: await this.verifier.verify\(\{ packageName: item.packageName/)
  const preview = result.service.slice(result.service.indexOf('async previewUpdate('))
  assert.match(preview, /await authorize\(operationSignal\)/)
  assert.match(preview, /await this.verifier.verify\(\{ packageName,/)
  assert.match(preview, /await intent.authorize\(operationSignal\)/)
  // pnpm 走共享作用域入口（同一 scope 的依赖共用一次鉴权）；元数据校验仍按
  // 真实插件 ID 单独授权，两者不能混。
  assert.match(result.service, /const registry = `\$\{this.registryOrigin\}\/registry\/by-package\/`/)
  assert.match(result.service, /host\}\/registry\/:_authToken=/)
  assert.match(result.service, /\$\{origin\}\/registry\/\$\{encodeURIComponent\(candidate.itemId \?\? ''\)\}/)
  // 授权这一步要把它授权到的目标交回来，预览不靠上一次检查留下的缓存。
  assert.match(result.service, /const authorized = await authorize\(operationSignal\)/)
  assert.match(result.service, /const updateTarget = authorized \?\? this.updateRegistry.get\(packageName\)/)
  assert.match(result.routes, /const authorize = async \(operationSignal: AbortSignal\): Promise<UpdateTarget> =>/)
  assert.match(result.routes, /preview = await install.previewUpdate\(packageName, signal, authorize\)\n/)
})

test('an update removes the installed package before installing the new version', () => {
  const update = output.service.slice(output.service.indexOf('async executeUpdate('))
  const body = update.slice(0, update.indexOf('\n  async '))
  const removal = body.indexOf('this.manager.removeBundle(intent.packageName)')
  const install = body.indexOf('this.manager.installBundle(')
  assert.ok(removal > 0 && install > removal, '必须先移除已装的包，再安装新版本')
  // 选中状态来自预览时读到的值，配置本身不在这两步的改写范围里。
  assert.match(body, /\{ enabled: intent.enabled, saveExact: true \}/)
  // 两步不是原子的：移除失败什么都没变，安装失败插件已经没了，文案要分开说。
  assert.match(body, /the update did not start and nothing changed/)
  assert.match(body, /Install the plugin again from the plugin market/)
  // 预览确认框要说清会先卸载再安装，以及配置保留。
  assert.match(output.locales, /confirmUpdateBody: "更新会先卸载当前版本，再安装下面这个版本，插件自己的配置会保留。"/)
  assert.match(output.locales, /confirmUpdateBody: "An update uninstalls the current version first/)
})

test('composes with source and authorization while preserving the native installed list', () => {
  assert.match(output.routes, /previewUpdate/)
  assert.match(output.routes, /force: true/)
  assert.match(output.settingsTab, /props.onUpdate/)
  assert.doesNotMatch(output.settingsTab, /systemComponents/)
  assert.match(output.settingsTab, /props.installations.map\(installation =>/)
  assert.match(output.service, /async executeUpdate/)
  assert.match(addMarketUpdateChecks(read('src/client/api.ts')), /installations\?updates=1/)
  assert.match(addMarketUpdateUiTests(installedTests), /product market update UI/)
})
test('fails closed on upstream drift and duplicate application', () => {
  assert.throws(() => addMarketUpdates({ ...input, service: '' }), /upstream anchor changed/)
  assert.throws(() => addMarketUpdates(output), /upstream anchor changed/)
})
