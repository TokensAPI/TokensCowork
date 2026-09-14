import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alignConnectionRpcScope, alignRuntimeDependencies, alignRuntimeResolutions } from './runtime-version-overlay.mjs'
import { alignResolverTestFileUrls } from './desktop-runtime-overlay.mjs'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { alignRuntimePeerAssertions } from './runtime-version-overlay.mjs'
import { alignWebSearchCommandDescription } from './runtime-version-overlay.mjs'

test('web-search slash command supplies a lazy description without changing its popup', () => {
  const source = 'command.register({ name: "tokens-dsh-web-search", description: "切换搜索引擎 / Switch web search engine", available: () => true, ui: { kind: "popupSelect" } })'
  const patched = alignWebSearchCommandDescription(source)
  let contribution
  new Function('command', patched)({ register: value => { contribution = value } })
  assert.equal(contribution.description(), '切换搜索引擎 / Switch web search engine')
  assert.equal(contribution.available(), true)
  assert.equal(contribution.ui.kind, 'popupSelect')
  assert.equal(alignWebSearchCommandDescription(patched), patched)
  assert.throws(() => alignWebSearchCommandDescription(source + source), /changed/)
  assert.throws(() => alignWebSearchCommandDescription(source.replace('切换搜索引擎', 'new contract')), /changed/)
  assert.throws(() => alignWebSearchCommandDescription(source.replace('command.register', 'different.register')), /changed/)

  const root = resolve(import.meta.dirname, '../../..')
  const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
  const plugin = product.plugins.find(item => item.id === 'tokens-dsh-web-search')
  const pinned = execFileSync('git', ['-C', resolve(root, plugin.path), 'show', `${plugin.commit}:lib/client.js`], { encoding: 'utf8', windowsHide: true })
  const adapted = alignWebSearchCommandDescription(pinned)
  assert.equal(adapted, pinned.replace('description: "切换搜索引擎 / Switch web search engine",', 'description: () => "切换搜索引擎 / Switch web search engine",'))
  assert.equal(alignWebSearchCommandDescription(adapted), adapted)

  const dev = readFileSync(resolve(root, 'scripts/dev-desktop.ps1'), 'utf8')
  const compile = readFileSync(resolve(root, 'build/pipeline/staging-plugins-compile.mjs'), 'utf8')
  assert.ok(dev.indexOf('staging-plugins-compile.mjs') < dev.indexOf("Invoke-Step '构建桌面主进程'"))
  assert.ok(compile.includes('const patched = alignWebSearchCommandDescription(source)'))
})

test('Market peer contracts follow the product pin without weakening their assertions', () => {
  const root = resolve(import.meta.dirname, '../../..')
  const manifest = JSON.parse(readFileSync(resolve(root, 'desktop/dsh-community-market/package.json'), 'utf8'))
  const source = readFileSync(resolve(root, 'desktop/dsh-community-market/tests/contracts.spec.ts'), 'utf8')
  const result = alignRuntimePeerAssertions(source, manifest.peerDependencies, '0.1.5-rc.2')
  assert.equal((result.match(/toHaveProperty\('@deepseek-ai\/dsh[^']*', '0\.1\.5-rc\.2'\)/g) ?? []).length, 7)
  assert.equal(result.replaceAll('0.1.5-rc.2', '0.1.5-rc.1'), source)
  assert.equal(alignRuntimePeerAssertions(result, manifest.peerDependencies, '0.1.5-rc.2'), result)
  assert.throws(() => alignRuntimePeerAssertions(source.replaceAll('0.1.5-rc.1', 'unexpected'), manifest.peerDependencies, '0.1.5-rc.2'), /drift/)
  assert.throws(() => alignRuntimePeerAssertions('changed upstream contract', {}, '0.1.5-rc.2'), /missing/)
})

test('aligns DSH dependencies and peers without changing other frameworks', () => {
  const manifest = {
    dependencies: { '@deepseek-ai/dsh': '0.1.5-rc.1', '@deepseek-ai/cordis': '4.0.2' },
    peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.3-alpha.1' },
  }
  alignRuntimeDependencies(manifest, '0.1.5-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.1.5-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/cordis'], '4.0.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-agent'], '0.1.5-rc.2')
})

test('replaces old vendored packages but retains the Desktop patch chain', () => {
  const result = alignRuntimeResolutions({
    '@deepseek-ai/dsh@npm:0.1.5-rc.1': 'file:vendor/dsh.tgz',
    '@deepseek-ai/dsh-agent-presets@npm:^0.1.5-rc.1':
      'patch:@deepseek-ai/dsh-agent-presets@file%3Avendor/presets.tgz#./patches/presets.patch',
    'open@npm:11.0.1': 'patch:open@npm%3A11.0.1#./patches/open.patch',
  }, '0.1.5-rc.2')
  assert.equal(result['@deepseek-ai/dsh@npm:0.1.5-rc.2'], 'npm:0.1.5-rc.2')
  assert.equal(result['@deepseek-ai/dsh-agent-presets@npm:0.1.5-rc.2'],
    'patch:@deepseek-ai/dsh-agent-presets@npm%3A0.1.5-rc.2#./patches/presets.patch')
  assert.equal(result['open@npm:11.0.1'], 'patch:open@npm%3A11.0.1#./patches/open.patch')
  assert.ok(!Object.keys(result).some(selector => selector.includes('rc.1')))
})

test('rejects an unknown runtime selector instead of silently missing the pin', () => {
  assert.throws(() => alignRuntimeResolutions({ '@deepseek-ai/dsh': 'latest' }, '0.1.5-rc.2'))
})

test('normalizes only drive-less Windows test URLs, never production code', () => {
  const fixture = 'file:///tmp/profile/ file:///C:/Users/test/ file:///D:/plugins/'
  assert.equal(alignResolverTestFileUrls(fixture, 'linux'), fixture)
  assert.equal(alignResolverTestFileUrls(fixture, 'win32'),
    'file:///C:/tmp/profile/ file:///C:/Users/test/ file:///D:/plugins/')
})

test('RPC compatibility patch is idempotent and rejects a changed upstream anchor', () => {
  const source = 'return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);'
  const patched = alignConnectionRpcScope(source)
  assert.match(patched, /caller.inject/)
  assert.equal(alignConnectionRpcScope(patched), patched)
  assert.throws(() => alignConnectionRpcScope('changed'))
})
