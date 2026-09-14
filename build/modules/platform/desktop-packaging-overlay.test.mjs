import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { alignFsExtArchitecture, alignMacReleaseChecks, configureDesktopPackage } from './desktop-packaging-overlay.mjs'

const read = path => readFileSync(new URL(`../../../desktop/dsh-plugin-desktop/${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const product = { name: 'TokensCowork', version: '0.5.0', appId: 'com.tokensapi.tokenscowork', windowsInstallerGuid: 'fixture-guid' }
test('packaging extraction preserves product identity and Windows-only exclusions', () => {
  const pristine = JSON.parse(read('package.json'))
  const mac = structuredClone(pristine)
  const win = structuredClone(pristine)
  configureDesktopPackage(mac, product, 'default')
  configureDesktopPackage(win, product, 'windows')
  assert.equal(win.version, product.version)
  assert.equal(win.build.nsis.guid, product.windowsInstallerGuid)
  assert.equal(win.build.nsis.artifactName, 'TokensCowork-${version}-${arch}-Setup.${ext}')
  assert.deepEqual(mac.build.files, pristine.build.files)
  assert.equal(win.build.files.length, pristine.build.files.length + 7)
  assert.deepEqual(win.build.files.slice(0, pristine.build.files.length), pristine.build.files)
})
test('upstream architecture and macOS quality-check anchors still match', () => {
  const fsExt = read('scripts/prepare-fs-ext.ts')
  const release = read('scripts/release-mac.ts')
  assert.match(alignFsExtArchitecture(fsExt), /arch: process.argv\[2\] \?\? process.arch/)
  assert.match(alignMacReleaseChecks(release), /product assembly owns the release quality gates/)
  assert.throws(() => alignFsExtArchitecture('changed upstream'))
  assert.throws(() => alignMacReleaseChecks('changed upstream'))
})
