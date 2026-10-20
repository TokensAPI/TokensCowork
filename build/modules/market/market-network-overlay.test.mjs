import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { PNPM_FETCH_TIMEOUT_MS, tolerateSlowDownloads } from './market-network-overlay.mjs'

const upstream = path => readFileSync(new URL(`../../../desktop/dsh-community-market/${path}`, import.meta.url), 'utf8')
const input = () => ({
  service: upstream('src/install/service.ts'),
  routes: upstream('src/host/routes.ts'),
  settingsTab: upstream('src/client/MarketSettingsTab.tsx'),
  locales: upstream('src/client/locales.ts'),
})

/** 从加工后的源码里取出整段实现并执行，而不是只比对字符串。 */
function evaluate(source, pattern, expression) {
  const match = source.match(pattern)
  assert.ok(match, `生成的源码里找不到 ${pattern}`)
  return new Function(`${stripTypeScriptTypes(match[0])}\nreturn (${expression})`)()
}

test('actual upstream package-manager calls run with the slow-link download budget', () => {
  const { service } = tolerateSlowDownloads(input())
  const args = evaluate(service, /const PNPM_FETCH_TIMEOUT_MS[\s\S]*?function slowNetworkPnpmArgs[\s\S]*?\n\}/u,
    "slowNetworkPnpmArgs(['add', '--save-exact', '@fixture/tool@1.0.0'])")
  assert.deepEqual(args, [`--config.fetchTimeout=${PNPM_FETCH_TIMEOUT_MS}`, 'add', '--save-exact', '@fixture/tool@1.0.0'])
  // 8.7 MB 的插件在 100 KB/s 的链路上要 ~87 秒，默认的 60 秒必然不够。
  assert.ok(PNPM_FETCH_TIMEOUT_MS >= 300000, '下载预算不足以覆盖慢链路')
  // 安装、更新、卸载都经过 runPnpm，预算和报告的 argv 都只在这一处注入。
  assert.match(service, /const args = slowNetworkPnpmArgs\(requested\)/u)
  assert.equal(service.split('this.pnpm.run(args').length - 1, 1)
})

test('the pnpm output of the reported failure is classified as a download timeout', () => {
  const { service } = tolerateSlowDownloads(input())
  const timedOut = evaluate(service, /const PNPM_DOWNLOAD_TIMEOUT[\s\S]*?function downloadTimedOut[\s\S]*?\n\}/u,
    'downloadTimedOut')
  // 2026-10-19 真实失败输出（单子 T0017）。
  assert.equal(timedOut([
    'pnpm --config.fetchTimeout=600000 add --save-exact @tokensapi/dsh-connect@2.9.4',
    '[WARN] GET https://market.tokensapi.ai/registry/tokens-connect/%40tokensapi%2Fdsh-connect/2.9.4/tarball error (23).'
    + ' Will retry in 10 seconds. 2 retries left.',
    '[23] The operation was aborted due to timeout',
    'TimeoutError: The operation was aborted due to timeout',
  ].join('\n')), true)
  for (const output of ['connect ETIMEDOUT 5.223.77.54:443', 'UND_ERR_HEADERS_TIMEOUT', 'ESOCKETTIMEDOUT']) {
    assert.equal(timedOut(output), true, output)
  }
  for (const output of [
    'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @tokensapi/dsh-connect@2.9.4',
    'ERR_PNPM_FETCH_401  GET https://market.tokensapi.ai/registry/by-package/: Unauthorized',
    '',
  ]) assert.equal(timedOut(output), false, output)
})

test('a timed-out download reaches the user as network copy with the detailed output kept', () => {
  const { service, routes, settingsTab, locales } = tolerateSlowDownloads(input())
  assert.match(service, /new MarketInstallError\('operation-timeout', 'The plugin package download timed out\.', details\)/u)
  assert.match(service, /\| 'operation-timeout'/u)
  assert.match(routes, /cause\.code === 'operation-timeout' \? 504/u)
  const isTimeout = evaluate(settingsTab, /function isDownloadTimeout[\s\S]*?\n\}/u, 'isDownloadTimeout')
  assert.equal(isTimeout({ name: 'MarketApiError', status: 504, code: 'operation-timeout', details: 'pnpm …' }), true)
  assert.equal(isTimeout({ name: 'MarketApiError', status: 502, code: 'operation-failed' }), false)
  assert.equal(isTimeout(new Error('boom')), false)
  assert.equal(isTimeout(undefined), false)
  // 两个失败分支都拿到 t；详细输出仍由 operationErrorDetails 单独取。
  assert.equal(settingsTab.split('operationErrorMessage(cause, t, ').length - 1, 2)
  assert.match(settingsTab, /if \(isDownloadTimeout\(cause\)\) return t\('operationTimeout'\)/u)
  assert.match(settingsTab, /setOperationErrorDetailsValue\(operationErrorDetails\(cause\)\)/u)
  assert.match(locales, /operationTimeout: "下载安装包超时，请检查网络后重试。"/u)
  assert.match(locales, /operationTimeout: "Downloading the plugin package timed out\. Check your network and try again\."/u)
})

test('re-applying the overlay fails on its own output', () => {
  const applied = tolerateSlowDownloads(input())
  assert.throws(() => tolerateSlowDownloads(applied), AnchorError)
})
