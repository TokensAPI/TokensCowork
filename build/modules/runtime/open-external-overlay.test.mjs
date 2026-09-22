import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { addDesktopOpenExternal, bridgeOpenExternal, declareOpenExternalCapability } from './open-external-overlay.mjs'

// Exercise the actual pinned upstream sources, not copied fixtures.
const root = resolve(import.meta.dirname, '../../..')
const bridgeSource = readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/src/host-runtime-bridge.ts'), 'utf8')
const runtimeSource = readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/src/runtime.ts'), 'utf8')
const patched = addDesktopOpenExternal({ bridge: bridgeSource, runtime: runtimeSource })

test('bridge overlay wires both sides of the RPC and appends the main-process implementation', () => {
  // Host proxy side.
  assert.ok(patched.bridge.includes("openExternal: url => send<void>('native:openExternal', [url])"))
  // Main side: the handler routes into the appended implementation.
  assert.ok(patched.bridge.includes("handle('native:openExternal', ([url]) => productOpenExternal(url))"))
  assert.ok(patched.bridge.includes('export async function productOpenExternal'))
  assert.ok(patched.bridge.includes('electron.shell.openExternal(target.href)'))
  // The appended TypeScript parses: type-stripping throws on syntax errors.
  assert.equal(typeof stripTypeScriptTypes(patched.bridge), 'string')
})

// The appended implementation is self-contained — URL plus a dynamic electron
// import — so the real thing can be lifted out and called. Anything the guard
// lets through fails later on that import, which is exactly how a rejected
// scheme is told apart from an accepted one.
const openExternal = new Function(
  `${stripTypeScriptTypes(patched.bridge.slice(patched.bridge.indexOf('export async function productOpenExternal')))
    .replace('export async function', 'async function')}
  return productOpenExternal`,
)()

const refusedScheme = /HTTPS origin required/u

test('the door opens for the deployment and for a console running locally', async () => {
  // A loopback console over plain HTTP is exactly what the plugin's own site
  // setting accepts, so the bridge must not be the stricter of the two.
  for (const url of ['https://tokensapi.ai/desktop-auth', 'http://127.0.0.1:3000/desktop-auth', 'http://localhost:3000/x', 'http://[::1]:3000/x']) {
    await assert.rejects(openExternal(url), error => !refusedScheme.test(String(error?.message)), url)
  }
})

test('every other scheme and any off-machine HTTP is refused', async () => {
  // This must not become a general "launch anything" hole in the native surface.
  for (const url of ['http://tokensapi.ai/desktop-auth', 'http://127.0.0.1.example.com/x', 'file:///c:/windows/system32/calc.exe', 'javascript:alert(1)', 'ftp://example.com/x']) {
    await assert.rejects(openExternal(url), refusedScheme, url)
  }
  await assert.rejects(openExternal('not a url'), /Invalid URL/u)
})

test('the overlay adds one capability and nothing else', () => {
  // The embedded sign-in window is deliberately gone: one door only.
  assert.ok(!patched.bridge.includes('BrowserWindow'))
  assert.ok(!patched.bridge.includes('openAuthWindow'))
  assert.ok(!patched.runtime.includes('openAuthWindow'))
  assert.equal(patched.bridge.split("'native:openExternal'").length - 1, 2, 'wired on both sides, once each')
})

test('runtime overlay declares the optional capability on DesktopRuntime', () => {
  assert.ok(patched.runtime.includes('openExternal?(url: string): Promise<void>'))
  assert.equal(typeof stripTypeScriptTypes(patched.runtime), 'string')
})

test('overlay fails closed on second application and on upstream drift', () => {
  assert.throws(() => bridgeOpenExternal(patched.bridge), /已包含外部浏览器登录桥/)
  assert.throws(() => declareOpenExternalCapability(patched.runtime), /已包含 openExternal/)
  for (const [before, after] of [
    ["void send('native:openProfileCreateWindow', [callback.id])", "void send('native:openProfileCreator', [callback.id])"],
    ["  handle('native:openProfileCreateWindow', ([id]) => runtime.openProfileCreateWindow({", "  handle('native:openProfileWindow', ([id]) => runtime.openProfileCreateWindow({"],
  ]) {
    assert.throws(() => bridgeOpenExternal(bridgeSource.replace(before, after)), /锚点/)
  }
  assert.throws(
    () => declareOpenExternalCapability(runtimeSource.replace('openProfileCreateWindow(options', 'openProfileWindow(options')),
    /锚点|openExternal/,
  )
})

test('overlay tolerates CRLF checkouts', () => {
  const crlf = addDesktopOpenExternal({
    bridge: bridgeSource.replaceAll('\n', '\r\n'),
    runtime: runtimeSource.replaceAll('\n', '\r\n'),
  })
  assert.equal(crlf.bridge, patched.bridge)
  assert.equal(crlf.runtime, patched.runtime)
})
