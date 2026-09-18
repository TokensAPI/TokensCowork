import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bridgeDesktopSystemProxy, bridgeWebFetchSystemProxy, resolveSystemProxyRoute } from './system-proxy-overlay.mjs'

const url = new URL('https://github.com/example')
const signal = () => new AbortController().signal
test('system proxy honors OS routing, explicit environment and bypass rules', async () => {
  const direct = { proxied: false }
  let calls = 0
  const resolve = async () => { calls++; return 'PROXY 127.0.0.1:7897; DIRECT' }
  const agent = uri => ({ uri })
  const route = await resolveSystemProxyRoute(url, direct, signal(), resolve, {}, agent)
  assert.equal(route.dispatcher.uri, 'http://127.0.0.1:7897/')
  assert.equal(route.owned, true)
  for (const env of [{ HTTPS_PROXY: '' }, { ALL_PROXY: 'socks5://localhost:1' }, { NO_PROXY: 'github.com' }, { no_proxy: '*' }]) {
    assert.equal(await resolveSystemProxyRoute(url, direct, signal(), resolve, env, agent), direct)
  }
  assert.equal(calls, 1)
  assert.equal(await resolveSystemProxyRoute(url, direct, signal(), async () => 'DIRECT', {}, agent), direct)
  await assert.rejects(resolveSystemProxyRoute(url, direct, signal(), async () => 'SOCKS5 localhost:1; DIRECT', {}, agent), /unsupported/)
  const existing = { proxied: true }
  assert.equal(await resolveSystemProxyRoute(url, existing, signal(), resolve, {}, agent), existing)
})
test('proxy resolution is cancellable and never falls back after errors', async () => {
  const controller = new AbortController()
  const pending = resolveSystemProxyRoute(url, { proxied: false }, controller.signal, () => new Promise(() => {}), {}, () => assert.fail())
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(resolveSystemProxyRoute(url, { proxied: false }, signal(), async () => { throw new Error('resolver failed') }, {}, () => assert.fail()), /resolver failed/)
})
test('Desktop bridge covers main and isolated host without changing upstream files', () => {
  for (const [file, role] of [['main.ts', 'main'], ['host-process.ts', 'supervisor'], ['host-process-entry.ts', 'host']]) {
    const source = readFileSync(new URL(`../../../desktop/dsh-plugin-desktop/src/${file}`, import.meta.url), 'utf8')
    const patched = bridgeDesktopSystemProxy(source, role)
    assert.notEqual(patched, source)
    assert.equal(bridgeDesktopSystemProxy(patched, role), patched)
    assert.throws(() => bridgeDesktopSystemProxy('drift', role), /changed/)
  }
  const source = 'const route = proxyRouteFor(url);\nif (route.proxied && !isNonPublicIpLiteral(url.hostname)) return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);'
  const patched = bridgeWebFetchSystemProxy(source)
  assert.match(patched, /isNonPublicIpLiteral\(url.hostname\) \?/)
  assert.match(patched, /route.dispatcher.close/)
  assert.equal(bridgeWebFetchSystemProxy(patched), patched)
  assert.throws(() => bridgeWebFetchSystemProxy('drift'), /changed/)
})
