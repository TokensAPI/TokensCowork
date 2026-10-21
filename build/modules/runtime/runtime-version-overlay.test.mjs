import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alignConnectionRpcScope, alignRuntimeDependencies, alignRuntimeResolutions } from './runtime-version-overlay.mjs'
import { alignResolverTestFileUrls } from './desktop-runtime-overlay.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { alignLegacySearchSettingsImport } from './runtime-version-overlay.mjs'

test('runtime preflight rejects a missing RPC package before reporting compatibility success', () => {
  const root = resolve(import.meta.dirname, '../../..')
  const buildRoot = resolve(root, '.build')
  mkdirSync(buildRoot, { recursive: true })
  const stage = mkdtempSync(resolve(buildRoot, 'desktop-runtime-gate-'))
  try {
    const modules = resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai')
    const fixtures = {
      'dsh-web-fetch-http': 'const route = proxyRouteFor(url);\nif (route.proxied && !isNonPublicIpLiteral(url.hostname)) return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);',
      'dsh-compaction-basic': `const instruction = '- Do NOT mention this summarization request or that the context was compacted.';
function summarize() {
  const messages = [...input.messages];
  const request = { model: target.model, messages, };
  return { summary, rawOutput, };
}`,
    }
    for (const [name, source] of Object.entries(fixtures)) {
      const lib = resolve(modules, name, 'lib')
      mkdirSync(lib, { recursive: true })
      writeFileSync(resolve(lib, 'index.js'), source)
    }
    const result = spawnSync(process.execPath, ['build/pipeline/staging-runtime-patch.mjs'], {
      cwd: root,
      env: { ...process.env, PRODUCT_STAGE_NAME: stage.slice(buildRoot.length + 1) },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /client-connection is not installed/)
    assert.doesNotMatch(result.stdout, /runtime compatibility checks passed/)
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('legacy free-search settings import into the web-search profile entry', () => {
  const legacy = 'const LEGACY_SECTION_ENTRIES = {\n shell: "pwsh-sandbox"\n};'
  const migrated = alignLegacySearchSettingsImport(legacy)
  assert.ok(migrated.includes('"free-search": "web-search-free"'))
  assert.equal(alignLegacySearchSettingsImport(migrated), migrated)
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

test('a patched vendored package at the pinned version keeps its vendored source', () => {
  // 2.0.18 的 dsh-experimental-inspector：npm 上同版本是另一次构建，上游补丁只对 vendor 里那份成立。
  const vendored = 'patch:@deepseek-ai/dsh-experimental-inspector@file%3Avendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-inspector-0.2.1-rc.2.tgz#./patches/dsh-experimental-inspector@0.2.1-rc.2.patch'
  const result = alignRuntimeResolutions({
    '@deepseek-ai/dsh-experimental-inspector@npm:0.2.1-rc.2': vendored,
    '@deepseek-ai/dsh-experimental-inspector@npm:^0.2.1-rc.2': vendored,
    '@deepseek-ai/dsh-web-app@npm:0.2.1-rc.2': 'file:vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-app-0.2.1-rc.2.tgz',
  }, '0.2.1-rc.2')
  assert.equal(result['@deepseek-ai/dsh-experimental-inspector@npm:0.2.1-rc.2'], vendored)
  assert.equal(result['@deepseek-ai/dsh-experimental-inspector@npm:^0.2.1-rc.2'], vendored)
  // 没有补丁的仍换成 npm 发布包；旧版本的带补丁条目仍按原规则换版本（见上一个用例）。
  assert.equal(result['@deepseek-ai/dsh-web-app@npm:0.2.1-rc.2'], 'npm:0.2.1-rc.2')
})
