import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { addMarketUpdates, addMarketUpdateChecks, addMarketUpdateUiTests, addMarketUpdateApiTests } from './market-update-overlay.mjs'
import { pinProductMarketSource, skipUpstreamSourceDescriptionTests, allowMarketSourceSyntheticProxy } from './market-source-overlay.mjs'
import { addMarketAuth } from './market-auth-overlay.mjs'

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
test('the actual staging entry point invokes update assembly and tests', () => {
  const entry = readFileSync(resolve(root, 'build/modules/market/market-staging-overlay.mjs'), 'utf8')
  assert.match(readFileSync(resolve(root, 'build/pipeline/staging-prepare.mjs'), 'utf8'), /applyMarketSourceOverlays\(\{ root, stage \}\)/)
  assert.match(entry, /const marketUpdates = addMarketUpdates\(/)
  assert.match(entry, /addMarketUpdateChecks\(readFileSync/)
  assert.match(entry, /addMarketUpdateUiTests\(readFileSync/)
  assert.match(entry, /market-update\.spec\.ts/)
  assert.doesNotMatch(entry, /separateInstalledSystemComponents|market-installed-ui-overlay/)
})

// Focused verification assembly: no whole-tree rebuild, dependency install, or installer packaging.
if (process.argv.includes('--stage') || process.argv.includes('--stage-client')) {
  const stage = resolve(root, '.build/desktop/dsh-community-market')
  for (const [key, path] of Object.entries(paths)) {
    if (process.argv.includes('--stage-client') && !['settingsTab', 'locales'].includes(key)) continue
    writeFileSync(resolve(stage, path), output[key])
  }
  writeFileSync(resolve(stage, 'src/client/api.ts'), addMarketUpdateChecks(read('src/client/api.ts')))
  writeFileSync(resolve(stage, 'tests/market-settings-tab.spec.tsx'), addMarketUpdateUiTests(installedTests))
  writeFileSync(resolve(stage, 'tests/client-api.spec.ts'), addMarketUpdateApiTests(read('tests/client-api.spec.ts')))
  copyFileSync(resolve(root, 'build/modules/market/market-update.spec.ts'), resolve(stage, 'tests/market-update.spec.ts'))
}
import { addPrivateRegistrySupport } from './market-registry-overlay.mjs'
