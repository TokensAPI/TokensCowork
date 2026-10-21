import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { alignFsExtArchitecture, alignMacEntitlementArchitecture, alignMacReleaseChecks, alignMacReleaseVerification, alignPackagedAgentsAnywhereCheck, configureDesktopPackage, macForeignArchExclusions } from './desktop-packaging-overlay.mjs'

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
  assert.equal(win.build.files.length, pristine.build.files.length + 11)
  assert.deepEqual(win.build.files.slice(0, pristine.build.files.length), pristine.build.files)
})

test('native verifier checks only selected runtime while retaining signature gates and cleanup', async () => {
  const source = alignMacReleaseVerification(read('scripts/verify-mac-release.ts'))
  const inventory = new URL('../../../desktop/dsh-plugin-desktop/scripts/mac-universal.ts', import.meta.url).href
  const entitlements = new URL('../../../desktop/dsh-plugin-desktop/scripts/verify-mac-entitlements.ts', import.meta.url).href
  // 2.0.18 起还 import ./verify-mac-runtime.ts（解释器载荷校验）；data: 模块里相对路径解析不了，一并映射成文件 URL。
  // 它依赖只在 staging 里安装的 @deepseek-ai/dsh-tool-workspace-dependencies；用例按 verifyRuntime 空实现跳过载荷校验，这里只需能解析。
  const macRuntime = 'data:text/javascript,export const verifyDesktopMacRuntime = () => {}'
  const code = stripTypeScriptTypes(source.slice(0, source.indexOf('const invokedPath =')).replace("'./mac-universal.ts'", JSON.stringify(inventory)).replace("'./verify-mac-entitlements.ts'", JSON.stringify(entitlements)).replace("'./verify-mac-runtime.ts'", JSON.stringify(macRuntime)))
  const { verifyMacRelease } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
  const previous = process.env.DSH_MAC_ARCH
  try {
    for (const [arch, binaryArch] of [['arm64', 'arm64'], ['x64', 'x86_64']]) {
      process.env.DSH_MAC_ARCH = arch
      const calls = []
      const options = { distDir: '/dist', productName: 'TokensCowork', listDmgs: () => ['/dist/package.dmg'], makeMountPoint: () => '/mount', removeMountPoint: () => {}, verifyRuntime: () => {}, run: (command, args) => calls.push([command, args]) }
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
  assert.match(alignMacReleaseChecks(release), /'--config.forceCodeSigning=true', '--config.mac.notarize=false',\n\s+'--config.dmg.format=ULFO', '--config.dmg.writeUpdateInfo=false',/)
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
  assert.equal((packages.match(/platform: windows\n/g) ?? []).length, 1)
  assert.equal((packages.match(/platform: windows-check\n/g) ?? []).length, 1)
  assert.equal((packages.match(/platform: macos/g) ?? []).length, 2)
  assert.match(packages, /electron_arch: arm64\n            binary_arch: arm64/)
  assert.match(packages, /electron_arch: x64\n            binary_arch: x86_64/)
  assert.match(packages, /DSH_MAC_ARCH="\$\{\{ matrix.electron_arch \}\}" corepack yarn product:dist:mac:auto/)
  assert.match(packages, /if: always\(\).*steps.signing.outputs.mode == 'signed'/)
  assert.match(packages, /find "\$\{dist\}" -type f -name '\*\.dmg'/)
})

test('native entitlement verification retains all required permissions for every Helper', async () => {
  const code = stripTypeScriptTypes(alignMacEntitlementArchitecture(read('scripts/verify-mac-entitlements.ts')))
  const { verifyMacEntitlements, MAC_REQUIRED_ENTITLEMENTS } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
  const previous = process.env.DSH_MAC_ARCH
  try {
    for (const [arch, expected] of [['arm64', 'arm64'], ['x64', 'x86_64']]) {
      process.env.DSH_MAC_ARCH = arch
      const calls = []
      verifyMacEntitlements('/product.app', 'TokensCowork', (path, slice) => {
        calls.push([path, slice])
        return Object.fromEntries(MAC_REQUIRED_ENTITLEMENTS.map(key => [key, true]))
      })
      assert.equal(calls.length, 5)
      assert.ok(calls.every(([, slice]) => slice === expected))
      assert.throws(() => verifyMacEntitlements('/product.app', 'TokensCowork', () => ({})), /Missing macOS entitlement/)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_MAC_ARCH
    else process.env.DSH_MAC_ARCH = previous
  }
})

test('the entitlements plist is copied to the path the upstream mac config signs with', async () => {
  const overlay = (await import('./overlays.mjs')).default.find(item => item.id === 'platform.mac-entitlements-plist')
  const [[source, target]] = overlay.copy
  assert.equal(readFileSync(source, 'utf8').includes('com.apple.security.device.audio-input'), true)
  // 2.0.18 起解释器载荷里的 Node 二进制按架构用不同的 entitlements 签名，两份也要进 staging。
  for (const file of ['jit-entitlements.plist', 'node-x64-entitlements.plist']) {
    const entry = overlay.copy.find(([, to]) => to.endsWith(`/${file}`))
    assert.ok(entry, `缺少 ${file}`)
    assert.ok(readFileSync(entry[0], 'utf8').includes('com.apple.security.cs.allow-jit'), `${file} 应声明 JIT`)
  }
  // 上游配置相对 dsh-plugin-desktop；换算到 staging 根必须正好落在复制目标上。
  const mac = JSON.parse(read('package.json')).build.mac
  for (const key of ['entitlements', 'entitlementsInherit']) {
    assert.equal(resolve('/stage/dsh-plugin-desktop', mac[key]), resolve('/stage', target), `build.mac.${key} 与复制目标不一致`)
  }
})

test('single-arch macOS packages drop the other architecture using the upstream x64ArchFiles list', () => {
  const pristine = JSON.parse(read('package.json'))
  for (const [arch, foreign] of [['arm64', 'x64'], ['x64', 'arm64']]) {
    const exclusions = macForeignArchExclusions(pristine.build, arch)
    // 2.0.17 新增的大体积原生包必须在剔除之列，且全部来自上游清单而不是手抄。
    for (const name of ['@deepseek-ai/libreoffice-kit', '@dataiku/uv', 'sherpa-onnx']) {
      assert.ok(exclusions.includes(`!node_modules/${name}-darwin-${foreign}/**`), `${arch}: 缺少 ${name}-darwin-${foreign}`)
    }
    assert.ok(exclusions.includes(`!node_modules/node-pty/prebuilds/darwin-${foreign}/**`))
    assert.ok(exclusions.every(entry => !entry.includes(`darwin-${arch}`)), `${arch}: 不能剔除本架构`)
    const configured = structuredClone(pristine)
    configureDesktopPackage(configured, product, `mac-${arch}`)
    assert.deepEqual(configured.build.files, [...pristine.build.files, ...exclusions])
  }
  const plain = structuredClone(pristine)
  configureDesktopPackage(plain, product, 'default')
  assert.deepEqual(plain.build.files, pristine.build.files)
  assert.throws(() => configureDesktopPackage(structuredClone(pristine), product, 'linux'), /unknown packaging target/)
  assert.throws(() => macForeignArchExclusions({ mac: { x64ArchFiles: '**/node_modules/{foo/**}' } }, 'arm64'), /darwin-\*/)
  assert.throws(() => macForeignArchExclusions({ mac: {} }, 'arm64'), /format changed/)
})

test('the packaged uv check follows the selected architecture and keeps upstream behaviour without one', () => {
  const source = alignPackagedAgentsAnywhereCheck(read('scripts/verify-packaged-runtime.ts'))
  const start = source.indexOf('    const selectedArch = ')
  const end = source.indexOf('{', source.indexOf('for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES', start)) + 1
  assert.ok(start > 0 && end > start)
  const entries = [
    { arch: 'arm64', path: 'node_modules/@dataiku/uv-darwin-arm64/bin/uv' },
    { arch: 'x86_64', path: 'node_modules/@dataiku/uv-darwin-x64/bin/uv' },
    { arch: 'arm64', path: 'node_modules/x/koffi.node' },
  ]
  const run = new Function('process', 'MACOS_UNIVERSAL_NATIVE_ENTRIES', `const seen = []; ${source.slice(start, end)} seen.push(entry.path) } return seen`)
  assert.deepEqual(run({ env: { DSH_MAC_ARCH: 'arm64' } }, entries), ['node_modules/@dataiku/uv-darwin-arm64/bin/uv'])
  assert.deepEqual(run({ env: { DSH_MAC_ARCH: 'x64' } }, entries), ['node_modules/@dataiku/uv-darwin-x64/bin/uv'])
  assert.deepEqual(run({ env: {} }, entries), ['node_modules/@dataiku/uv-darwin-arm64/bin/uv', 'node_modules/@dataiku/uv-darwin-x64/bin/uv'])
  assert.throws(() => alignPackagedAgentsAnywhereCheck(source), /anchor changed/)
})

test('the release verifier retries a flaky stapler lookup without loosening the other gates', async () => {
  const source = alignMacReleaseVerification(read('scripts/verify-mac-release.ts'))
  const inventory = new URL('../../../desktop/dsh-plugin-desktop/scripts/mac-universal.ts', import.meta.url).href
  const entitlements = new URL('../../../desktop/dsh-plugin-desktop/scripts/verify-mac-entitlements.ts', import.meta.url).href
  // 2.0.18 起还 import ./verify-mac-runtime.ts（解释器载荷校验）；data: 模块里相对路径解析不了，一并映射成文件 URL。
  // 它依赖只在 staging 里安装的 @deepseek-ai/dsh-tool-workspace-dependencies；用例按 verifyRuntime 空实现跳过载荷校验，这里只需能解析。
  const macRuntime = 'data:text/javascript,export const verifyDesktopMacRuntime = () => {}'
  const code = stripTypeScriptTypes(source.slice(0, source.indexOf('const invokedPath =')).replace("'./mac-universal.ts'", JSON.stringify(inventory)).replace("'./verify-mac-entitlements.ts'", JSON.stringify(entitlements)).replace("'./verify-mac-runtime.ts'", JSON.stringify(macRuntime)))
  const { verifyMacRelease } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
  const previous = process.env.DSH_MAC_ARCH
  process.env.DSH_MAC_ARCH = 'arm64'
  process.env.TOKENS_STAPLE_RETRY_MS = '0'
  try {
    const validateCalls = []
    let failures = 2
    const options = { distDir: '/dist', productName: 'TokensCowork', listDmgs: () => ['/dist/package.dmg'], makeMountPoint: () => '/mount', removeMountPoint: () => {}, verifyRuntime: () => {},
      run: (command, args) => { if (command === 'xcrun' && args[1] === 'validate') { validateCalls.push(args); if (failures-- > 0) throw new Error('The network connection was lost.') } } }
    verifyMacRelease(options)
    assert.equal(validateCalls.length, 3)
    assert.throws(() => verifyMacRelease({ ...options, run: (command, args) => { if (command === 'xcrun' && args[1] === 'validate') throw new Error('lost') } }), /failed to verify/)
  } finally {
    delete process.env.TOKENS_STAPLE_RETRY_MS
    if (previous === undefined) delete process.env.DSH_MAC_ARCH
    else process.env.DSH_MAC_ARCH = previous
  }
})
