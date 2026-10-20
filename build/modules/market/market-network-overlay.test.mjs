import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { addPrivateRegistrySupport } from './market-registry-overlay.mjs'
import { addMarketUpdates } from './market-update-overlay.mjs'
import { PNPM_FETCH_TIMEOUT_MS, tolerateSlowDownloads } from './market-network-overlay.mjs'

const root = resolve(import.meta.dirname, '../../..')
const upstream = path => readFileSync(resolve(root, 'desktop/dsh-community-market', path), 'utf8')
const origin = JSON.parse(readFileSync(resolve(root, 'market/server/source.config.json'), 'utf8')).origin

/**
 * 慢网络覆盖排在插件更新与私有 Registry 之后：下载预算写进 Registry 建的
 * 那份临时 .npmrc，所以这里按装配顺序叠三层，拿到真实 staging 的形态。
 */
function input() {
  const updated = addMarketUpdates({
    service: upstream('src/install/service.ts'),
    routes: upstream('src/host/routes.ts'),
    types: upstream('src/api-types.ts'),
    settingsTab: upstream('src/client/MarketSettingsTab.tsx'),
    locales: upstream('src/client/locales.ts'),
  })
  const registry = addPrivateRegistrySupport({
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
  return {
    service: registry.service,
    routes: registry.routes,
    settingsTab: updated.settingsTab,
    locales: updated.locales,
  }
}

/** 从加工后的源码里取出整段实现并执行，而不是只比对字符串。 */
function evaluate(source, pattern, expression, scope = {}) {
  const match = source.match(pattern)
  assert.ok(match, `生成的源码里找不到 ${pattern}`)
  // 类方法先改写成独立函数，剥类型注解才认得。
  const body = match[0]
    .replace(/^ {2}private async (\w+)/u, 'async function $1')
    .replace(/^ {2}private (\w+)/u, 'function $1')
  const names = Object.keys(scope)
  return new Function(...names, `${stripTypeScriptTypes(body)}\nreturn (${expression})`)(...names.map(name => scope[name]))
}

test('the slow-link download budget reaches pnpm through the per-operation npmrc', async () => {
  const { service } = tolerateSlowDownloads(input())
  const lines = await evaluate(service, / {2}private async productNpmrcLines\(\)[\s\S]*?\n {2}\}/u,
    'productNpmrcLines.call({ registryOrigin: undefined })',
    { PNPM_FETCH_TIMEOUT_MS, PRIVATE_REGISTRY_SCOPE: '@tokensapi', MarketInstallError: Error })
  // 没有私有 Registry 时也要写预算：慢链路和公共 npm 一样会超时。
  assert.deepEqual(lines, [`fetch-timeout=${PNPM_FETCH_TIMEOUT_MS}`])
  // 8.7 MB 的插件在 100 KB/s 的链路上要 ~87 秒，默认的 60 秒必然不够。
  assert.ok(PNPM_FETCH_TIMEOUT_MS >= 300000, '下载预算不足以覆盖慢链路')
  // 预算只在这一处注入，安装、更新、卸载共用同一个写入器。
  assert.equal(service.split('fetch-timeout=').length - 1, 1)
  assert.equal(service.split('withProductNpmrc(() =>').length - 1, 4)
})

test('a timed-out download is read off the official manager own classification', () => {
  const { service } = tolerateSlowDownloads(input())
  // 固定上游的失败分类里必须真有 timeout 这个取值，上游改名就在这里报错，
  // 而不是等到用户只看到“包管理器未成功完成”。
  const kinds = readFileSync(
    resolve(root, 'desktop/deepseek-harness/packages/boot/plugin-manager/src/types.ts'), 'utf8',
  ).match(/export type PluginInstallFailureKind =[\s\S]*?\n\n/u)
  assert.ok(kinds)
  assert.match(kinds[0], /\| 'timeout'/u)
  assert.match(service, /result\.packageResult\?\.kind === 'timeout' \|\| result\.packageResult\?\.timedOut === true/u)
  // 分类必须排在通用失败之前，否则超时会被通用文案吞掉。
  assert.ok(service.indexOf("=== 'timeout'") < service.indexOf('throw this.packageManagerError(managementMessage'))
})

test('a timed-out download reaches the user as network copy with the detailed output kept', () => {
  const { service, routes, settingsTab, locales } = tolerateSlowDownloads(input())
  assert.match(service, /\| 'operation-timeout'/u)
  const error = evaluate(service, / {2}private downloadTimeoutError\(details[\s\S]*?\n {2}\}/u,
    'downloadTimeoutError', { MarketInstallError: class extends Error {
      constructor(code, message, details) { super(message); this.code = code; this.details = details }
    } })
  const logged = []
  const timeout = error.call({ logFailure: message => logged.push(message) }, 'pnpm …')
  assert.equal(timeout.code, 'operation-timeout')
  assert.equal(timeout.details, 'pnpm …', '详细输出必须原样保留')
  assert.match(logged[0], /download timed out/u)
  // 空输出时不要造出一个只有换行的 details。
  assert.equal(error.call({}, '').details, undefined)
  assert.match(routes, /cause\.code === 'operation-timeout' \? 504/u)
  const isTimeout = evaluate(settingsTab, /function isDownloadTimeout[\s\S]*?\n\}/u, 'isDownloadTimeout')
  assert.equal(isTimeout({ name: 'MarketApiError', status: 504, code: 'operation-timeout', details: 'pnpm …' }), true)
  assert.equal(isTimeout({ name: 'MarketApiError', status: 502, code: 'operation-failed' }), false)
  assert.equal(isTimeout(new Error('boom')), false)
  assert.equal(isTimeout(undefined), false)
  // 三个失败分支都拿到 t；详细输出仍由 operationErrorDetails 单独取。
  assert.equal(settingsTab.split('operationErrorMessage(cause, t, ').length - 1, 3)
  assert.match(settingsTab, /if \(isDownloadTimeout\(cause\)\) return t\('operationTimeout'\)/u)
  assert.match(settingsTab, /setOperationErrorDetailsValue\(operationErrorDetails\(cause\)\)/u)
  assert.match(locales, /operationTimeout: "下载安装包超时，请检查网络后重试。"/u)
  assert.match(locales, /operationTimeout: "Downloading the plugin package timed out\. Check your network and try again\."/u)
})

test('re-applying the overlay fails on its own output', () => {
  const applied = tolerateSlowDownloads(input())
  assert.throws(() => tolerateSlowDownloads(applied), AnchorError)
})
