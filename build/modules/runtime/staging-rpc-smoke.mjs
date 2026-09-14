// Exercise the installed runtime with real Cordis scopes, without Electron or credentials.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { productStage } from '../../pipeline/paths.mjs'

const require = createRequire(resolve(productStage(resolve(import.meta.dirname, '../../..')), 'dsh-plugin-desktop/package.json'))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { HostConnectionService } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')))
const ctx = new Context()
const routes = new Map()
const web = ctx.plugin(scope => { scope.provide('webServer', { register(route) {
  assert.ok(!routes.has(route.path))
  routes.set(route.path, route)
  return () => routes.delete(route.path)
} }) })
await web.await()
const provider = ctx.plugin(scope => { new HostConnectionService(scope, [], { isAuthenticated: () => false }) })
await provider.await()
let disposeRoute
let caught
const consumer = ctx.plugin({ inject: ['connection', 'webServer'], apply(scope) {
  try { disposeRoute = scope.connection.rpc.handle('/test-plugin', async () => ({ success: true })) }
  catch (error) { caught = error }
} })
await consumer.await()
await new Promise(resolve => setTimeout(resolve, 100))
try {
  if (caught) throw caught
  assert.ok(routes.has('/test-plugin'), 'RPC route must become available')
  const route = routes.get('/test-plugin')
  for (const [host, status] of [['evil.example', 403], ['127.0.0.1', 401]]) {
    let actual
    await route.handler({ headers: { host }, socket: {} }, { writeHead(code) { actual = code }, end() {} })
    assert.equal(actual, status, 'Host fence and authentication must remain enforced')
  }
  await disposeRoute()
  assert.equal(routes.size, 0, 'Explicit disposer must remove route')
  const second = ctx.plugin({ inject: ['connection'], apply(scope) {
    scope.connection.rpc.handle('/second-plugin', async () => ({}))
  } })
  await second.await()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(routes.has('/second-plugin'))
  await second.dispose()
  assert.equal(routes.size, 0, 'Unloading caller must remove route')
  console.log('RPC smoke passed: real Cordis registration, authorization and disposal')
} finally {
  await consumer.dispose()
  await provider.dispose()
  await web.dispose()
}
