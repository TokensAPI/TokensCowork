import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { addPrivateRegistrySupport, widenInstallCandidateRegistry } from './market-registry-overlay.mjs'
import { addMarketUpdates } from './market-update-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const upstream = path => readFileSync(resolve(root, 'desktop/dsh-community-market', path), 'utf8')
const origin = JSON.parse(readFileSync(resolve(root, 'market/server/source.config.json'), 'utf8')).origin

/**
 * 私有 Registry 覆盖排在插件更新之后，锚点里有一部分是更新覆盖产出的文本，
 * 所以这里按装配顺序先叠更新再叠 Registry，拿到的就是真实 staging 的形态。
 */
function assemble() {
  const updated = addMarketUpdates({
    service: upstream('src/install/service.ts'),
    routes: upstream('src/host/routes.ts'),
    types: upstream('src/api-types.ts'),
    settingsTab: upstream('src/client/MarketSettingsTab.tsx'),
    locales: upstream('src/client/locales.ts'),
  })
  return addPrivateRegistrySupport({
    http: upstream('src/network/restricted-http.ts'),
    index: upstream('src/index.ts'),
    service: updated.service,
    routes: updated.routes,
    identity: upstream('src/contracts/identity.ts'),
    types: upstream('src/contracts/types.ts'),
    providerSchema: upstream('docs/schemas/catalog-provider-page.schema.json'),
    snapshotSchema: upstream('docs/schemas/catalog-snapshot.schema.json'),
    providerTypes: upstream('src/contracts/generated/catalog-provider-page.ts'),
    snapshotTypes: upstream('src/contracts/generated/catalog-snapshot.ts'),
  }, origin)
}

test('actual upstream candidate expression admits npm and self-hosted packages only', () => {
  const patched = widenInstallCandidateRegistry(upstream('src/install/service.ts'))
  // Extract the complete ternary rather than testing only a registry substring.
  const statement = patched.match(/const packageName = ([\s\S]*?\n\s*: undefined)/)
  assert.ok(statement)
  const candidate = new Function('item', 'source', 'safePackageName', `return (${statement[1]})`)
  for (const registry of ['npm', 'tokenscowork']) {
    assert.equal(candidate({package:{registry,name:'@fixture/tool'}},undefined,()=>true),'@fixture/tool')
    assert.equal(candidate({package:{registry,name:'invalid'}},undefined,()=>false),undefined)
    assert.equal(candidate({package:{registry,name:'@fixture/tool'}},{},()=>true),undefined)
  }
  assert.equal(candidate({package:{registry:'unknown',name:'@fixture/tool'}},undefined,()=>true),undefined)
  assert.equal(candidate({},undefined,()=>true),undefined)
  assert.throws(()=>widenInstallCandidateRegistry(patched),AnchorError)
})

/** 从加工后的源码里取出临时 .npmrc 的三段实现并真正执行。 */
function npmrcRuntime(service) {
  const pick = (pattern, label) => {
    const match = service.match(pattern)
    assert.ok(match, `生成的源码里找不到 ${label}`)
    return match[0]
  }
  // 下载预算由后面的 market.slow-network 加进同一处，本测试只叠到 Registry，
  // 所以它可以缺席；预算本身在 market-network-overlay.test.mjs 里验证。
  const literal = (name, pattern, required = true) => {
    const match = service.match(new RegExp(`const ${name} = (${pattern})`, 'u'))
    assert.ok(match || !required, `生成的源码里找不到常量 ${name}`)
    return match?.[1]
  }
  const text = (name) => {
    const value = literal(name, "'[^']*'")
    return value === undefined ? undefined : value.slice(1, -1)
  }
  const source = stripTypeScriptTypes([
    pick(/export async function removeProductNpmrc[\s\S]*?\n\}/u, 'removeProductNpmrc')
      .replace('export async function', 'async function'),
    pick(/ {2}private async productNpmrcLines\(\)[\s\S]*?\n {2}\}/u, 'productNpmrcLines')
      .replace('  private async productNpmrcLines()', 'async function productNpmrcLines()'),
    pick(/ {2}private async withProductNpmrc<T>[\s\S]*?\n {2}\}/u, 'withProductNpmrc')
      .replace('  private async withProductNpmrc<T>', 'async function withProductNpmrc'),
  ].join('\n\n'))
  class MarketInstallError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details }
  }
  const build = new Function(
    'PRODUCT_NPMRC_FILENAME', 'PRODUCT_NPMRC_MARKER', 'PNPM_FETCH_TIMEOUT_MS', 'PRIVATE_REGISTRY_SCOPE',
    'MarketInstallError', 'join', 'readFile', 'writeFile', 'unlink',
    `${source}\nreturn { removeProductNpmrc, productNpmrcLines, withProductNpmrc }`,
  )
  const filename = text('PRODUCT_NPMRC_FILENAME')
  const marker = text('PRODUCT_NPMRC_MARKER')
  const api = build(
    filename,
    marker,
    Number(literal('PNPM_FETCH_TIMEOUT_MS', '\\d+', false) ?? 0),
    text('PRIVATE_REGISTRY_SCOPE'),
    MarketInstallError, join, readFile, writeFile, unlink,
  )
  const instance = (dir, options = {}) => {
    const self = {
      registryOrigin: options.registryOrigin ?? origin,
      registryToken: options.registryToken,
      profile: () => ({ name: 'web', dir }),
      productNpmrcLines: () => api.productNpmrcLines.call(self),
    }
    return {
      marker,
      path: join(dir, filename),
      run: operation => api.withProductNpmrc.call(self, operation),
      clean: () => api.removeProductNpmrc(dir),
      lines: () => api.productNpmrcLines.call(self),
    }
  }
  return { instance, marker }
}

function temporaryProfile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'market-npmrc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the product npmrc exists only while one package operation runs', async t => {
  const { service } = assemble()
  const dir = temporaryProfile(t)
  const profile = npmrcRuntime(service).instance(dir, { registryToken: async () => 'sk-fixture-key' })
  let observed
  const result = await profile.run(async () => {
    observed = readFileSync(profile.path, 'utf8')
    return 'done'
  })
  assert.equal(result, 'done')
  assert.ok(observed.startsWith(profile.marker), '首行必须是产品标记，别人的 .npmrc 才认得出来')
  assert.match(observed, /^@tokensapi:registry=https:\/\/\S+\/registry\/by-package\/$/mu)
  assert.match(observed, /^\/\/\S+\/registry\/:_authToken=sk-fixture-key$/mu)
  assert.equal(existsSync(profile.path), false, '操作结束后文件必须不存在')
})

test('a failed package operation leaves no product npmrc behind', async t => {
  const { service } = assemble()
  const dir = temporaryProfile(t)
  const profile = npmrcRuntime(service).instance(dir, { registryToken: async () => 'sk-fixture-key' })
  await assert.rejects(profile.run(async () => { throw new Error('pnpm failed') }), /pnpm failed/u)
  assert.equal(existsSync(profile.path), false, '失败路径也必须不留文件')
})

test("a user's own npmrc stops the operation instead of being overwritten", async t => {
  const { service } = assemble()
  const dir = temporaryProfile(t)
  const profile = npmrcRuntime(service).instance(dir, { registryToken: async () => 'sk-fixture-key' })
  const mine = 'registry=https://my-mirror.example/\n'
  writeFileSync(profile.path, mine)
  let ran = false
  await assert.rejects(profile.run(async () => { ran = true }), error => {
    assert.equal(error.code, 'conflict')
    return true
  })
  assert.equal(ran, false, '用户的配置在位时这次操作根本不能跑')
  assert.equal(readFileSync(profile.path, 'utf8'), mine, '用户自己的 .npmrc 一个字节都不能动')
  // 清理也只认产品标记。
  await profile.clean()
  assert.equal(readFileSync(profile.path, 'utf8'), mine)
})

test('a product npmrc left by a killed process is cleared, a foreign one is kept', async t => {
  const { service } = assemble()
  const dir = temporaryProfile(t)
  const runtime = npmrcRuntime(service)
  const profile = runtime.instance(dir, { registryToken: async () => 'sk-fixture-key' })
  writeFileSync(profile.path, `${runtime.marker}\nfetch-timeout=600000\n`)
  await profile.clean()
  assert.equal(existsSync(profile.path), false)
  writeFileSync(profile.path, 'registry=https://my-mirror.example/\n')
  await profile.clean()
  assert.equal(existsSync(profile.path), true)
})

test('an anonymous operation writes no token line and an invalid key never reaches the file', async t => {
  const { service } = assemble()
  const dir = temporaryProfile(t)
  const runtime = npmrcRuntime(service)
  const anonymous = await runtime.instance(dir, { registryToken: async () => '' }).lines()
  assert.ok(anonymous.some(line => line.startsWith('@tokensapi:registry=')))
  assert.equal(anonymous.some(line => line.includes('_authToken')), false)
  const invalid = runtime.instance(dir, { registryToken: async () => 'not-a-key' })
  await assert.rejects(invalid.run(async () => {}), error => {
    assert.equal(error.code, 'operation-failed')
    assert.doesNotMatch(error.message, /not-a-key/u)
    return true
  })
  assert.equal(existsSync(invalid.path), false)
})

test('the API Key reaches pnpm only through the per-operation npmrc', () => {
  const { service } = assemble()
  // argv 和日志都不再碰 token：整个安装服务里 `_authToken` 只出现一次，
  // 就是写进临时 .npmrc 的那一行。
  assert.equal(service.split('_authToken').length - 1, 1)
  const lines = service.match(/ {2}private async productNpmrcLines\(\)[\s\S]*?\n {2}\}/u)
  assert.ok(lines)
  assert.match(lines[0], /_authToken/u)
  // 失败回显来自官方管理器的 packageResult/diagnostic，不包含我们写的配置。
  assert.doesNotMatch(service, /logFailure\?\.\([^)]*registryToken/u)
})

test('re-applying the private Registry overlay fails on its own output', () => {
  const applied = assemble()
  assert.throws(() => addPrivateRegistrySupport(applied, origin), AnchorError)
})
