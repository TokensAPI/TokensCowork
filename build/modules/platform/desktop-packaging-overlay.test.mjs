import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { alignFsExtArchitecture, alignMacReleaseChecks, alignMacReleaseVerification, configureDesktopPackage } from './desktop-packaging-overlay.mjs'

const read = path => readFileSync(new URL(`../../../desktop/dsh-plugin-desktop/${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const product = { name: 'TokensCowork', version: '0.5.0', appId: 'com.tokensapi.tokenscowork', windowsInstallerGuid: 'fixture-guid' }
test('packaging extraction preserves product identity and Windows-only exclusions', () => {
  const pristine = JSON.parse(read('package.json'))
  const mac = structuredClone(pristine)
  const win = structuredClone(pristine)
  configureDesktopPackage(mac, product, 'default')
  configureDesktopPackage(win, product, 'windows')
  assert.equal(win.version, product.version)
  assert.equal(mac.build.afterSign, './scripts/product-notarize.mjs')
  assert.equal(win.description, 'TokensCowork desktop application')
  assert.equal(mac.description, win.description)
  assert.equal(win.build.nsis.guid, product.windowsInstallerGuid)
  assert.equal(win.build.nsis.artifactName, 'TokensCowork-${version}-${arch}-Setup.${ext}')
  assert.deepEqual(mac.build.files, pristine.build.files)
  assert.equal(win.build.files.length, pristine.build.files.length + 7)
  assert.deepEqual(win.build.files.slice(0, pristine.build.files.length), pristine.build.files)
})

test('native verifier checks only selected runtime while retaining signature gates and cleanup', async () => {
  const source = alignMacReleaseVerification(read('scripts/verify-mac-release.ts'))
  const inventory = new URL('../../../desktop/dsh-plugin-desktop/scripts/mac-universal.ts', import.meta.url).href
  const code = stripTypeScriptTypes(source.slice(0, source.indexOf('const invokedPath =')).replace("'./mac-universal.ts'", JSON.stringify(inventory)))
  const { verifyMacRelease } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
  const previous = process.env.DSH_MAC_ARCH
  try {
    for (const [arch, binaryArch] of [['arm64', 'arm64'], ['x64', 'x86_64']]) {
      process.env.DSH_MAC_ARCH = arch
      const calls = []
      const options = { distDir: '/dist', productName: 'TokensCowork', listDmgs: () => ['/dist/package.dmg'], makeMountPoint: () => '/mount', removeMountPoint: () => {}, run: (command, args) => calls.push([command, args]) }
      verifyMacRelease(options)
      const nativeChecks = calls.filter(([command]) => command === 'lipo')
      assert.ok(nativeChecks.length > 1)
      assert.ok(nativeChecks.every(([, args]) => args.at(-1) === binaryArch))
      assert.ok(calls.some(([command]) => command === 'spctl'))
      assert.ok(calls.some(([command, args]) => command === 'xcrun' && args[1] === 'validate'))
      const cleanup = []
      assert.throws(() => verifyMacRelease({ ...options, run: (command, args) => { cleanup.push([command, args]); if (command === 'codesign') throw new Error('invalid signature') } }), /failed to verify/)
      assert.ok(cleanup.some(([command, args]) => command === 'hdiutil' && args[0] === 'detach'))
    }
    stripTypeScriptTypes(alignMacReleaseChecks(read('scripts/release-mac.ts')))
  } finally {
    if (previous === undefined) delete process.env.DSH_MAC_ARCH
    else process.env.DSH_MAC_ARCH = previous
  }
})
test('upstream architecture and macOS quality-check anchors still match', () => {
  const fsExt = read('scripts/prepare-fs-ext.ts')
  const release = read('scripts/release-mac.ts')
  assert.match(alignFsExtArchitecture(fsExt), /arch: process.argv\[2\] \?\? process.arch/)
  assert.match(alignMacReleaseChecks(release), /product assembly owns the release quality gates/)
  assert.match(alignMacReleaseChecks(release), /'--publish', 'never'/)
  assert.match(alignMacReleaseChecks(release), /'--config.forceCodeSigning=true', '--config.mac.notarize=false'/)
  assert.doesNotMatch(alignMacReleaseChecks(release), /--universal|prepareInstalledMacUniversalRuntime/)
  assert.match(alignMacReleaseChecks(release), /--\$\{releaseEnvironment.DSH_MAC_ARCH\}/)
  assert.doesNotMatch(alignMacReleaseChecks(release), /FORBIDDEN_MACOS_UNIVERSAL_ENTRIES|Unexpected generated native runtime/)
  assert.throws(() => alignMacReleaseChecks(release.replace("'exec', 'electron-builder'", "'exec', 'changed-builder'")))
  assert.throws(() => alignFsExtArchitecture('changed upstream'))
  assert.throws(() => alignMacReleaseChecks('changed upstream'))
})

test('release matrix builds native macOS packages and preserves recovery artifacts', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/release-desktop.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const packages = workflow.slice(workflow.indexOf('  build-packages:\n'), workflow.indexOf('  publish-release:\n'))
  assert.equal((packages.match(/platform: windows/g) ?? []).length, 1)
  assert.equal((packages.match(/platform: macos/g) ?? []).length, 2)
  assert.match(packages, /electron_arch: arm64\n            binary_arch: arm64/)
  assert.match(packages, /electron_arch: x64\n            binary_arch: x86_64/)
  assert.match(packages, /DSH_MAC_ARCH="\$\{\{ matrix.electron_arch \}\}" corepack yarn product:dist:mac:auto/)
  assert.match(packages, /if: always\(\).*steps.signing.outputs.mode == 'signed'/)
  assert.match(packages, /find "\$\{dist\}" -type f -name '\*\.dmg'/)
})
