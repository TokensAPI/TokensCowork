import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  configureWindowsStorePackage, skipAppUserModelIdInStorePackage, storeIdentity, storeManifestTemplate, UPSTREAM_APP_USER_MODEL_ID,
} from './windows-store-overlay.mjs'

const product = JSON.parse(readFileSync(new URL('../../../product.json', import.meta.url), 'utf8')).product

test('store identity in product.json matches Partner Center exactly', () => {
  // 三项都是 Partner Center 给的，拼错一个字上传就被拒
  assert.deepEqual(storeIdentity(product.windowsStore), {
    identityName: '1FCF6A48.TokensCowork',
    publisher: 'CN=CC961BCF-9D05-4249-B8AC-DA55950DD99A',
    publisherDisplayName: '杭州欧瑞德林经济咨询有限公司',
  })
  assert.throws(() => storeIdentity(undefined), /windowsStore is missing/)
  assert.throws(() => storeIdentity({ ...product.windowsStore, publisher: 'CN=TokensAPI' }), /CN=<GUID>/)
  assert.throws(() => storeIdentity({ ...product.windowsStore, identityName: '' }), /Identity\/Name/)
  assert.throws(() => storeIdentity({ ...product.windowsStore, publisherDisplayName: ' ' }), /PublisherDisplayName/)
})

test('appx target is added next to NSIS with the store identity, unvirtualized data and a white plate', () => {
  const desktopPackage = { build: { win: { target: [{ target: 'nsis', arch: ['x64'] }] }, nsis: { oneClick: false } } }
  configureWindowsStorePackage(desktopPackage, product)
  const { appx } = desktopPackage.build
  assert.equal(appx.identityName, '1FCF6A48.TokensCowork')
  assert.equal(appx.publisher, 'CN=CC961BCF-9D05-4249-B8AC-DA55950DD99A')
  assert.equal(appx.publisherDisplayName, '杭州欧瑞德林经济咨询有限公司')
  assert.equal(appx.applicationId, 'TokensCowork')
  assert.equal(appx.backgroundColor, '#FFFFFF', 'transparent plates are filled with the accent colour (blue)')
  assert.deepEqual(appx.capabilities, ['runFullTrust', 'unvirtualizedResources'])
  assert.equal(appx.customManifestPath, 'appxmanifest.xml')
  assert.equal(appx.minVersion, '10.0.17763.0', 'desktop6 write-virtualization opt-out needs 1809')
  assert.equal(appx.electronUpdaterAware, false)
  assert.equal(appx.addAutoLaunchExtension, false)
  assert.equal(appx.artifactName, 'TokensCowork-${version}-${arch}-Store.${ext}')
  assert.deepEqual(desktopPackage.build.nsis, { oneClick: false }, 'NSIS untouched')
  assert.deepEqual(desktopPackage.build.win.target, [{ target: 'nsis', arch: ['x64'] }], 'EXE stays the default Windows target')
  assert.throws(() => configureWindowsStorePackage({ build: { appx: {} } }, product), /upstream now configures appx/)
})

// electron-builder 26 的 templates/appx/appxmanifest.xml 开头（锚点所在部分原样）
const template = `<?xml version="1.0" encoding="utf-8"?>
<Package
   xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
   xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
   xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
   xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <Identity Name="\${identityName}" ProcessorArchitecture="\${arch}" Publisher='\${publisher}' Version="\${version}" />
  <Properties>
    <DisplayName>\${displayName}</DisplayName>
    <Logo>\${logo}</Logo>
  </Properties>
  \${capabilities}
</Package>`

test('store manifest disables file and registry write virtualization on top of the upstream template', () => {
  const manifest = storeManifestTemplate(template)
  assert.match(manifest, /xmlns:desktop6="http:\/\/schemas\.microsoft\.com\/appx\/manifest\/desktop\/windows10\/6"/)
  assert.match(manifest, /<desktop6:FileSystemWriteVirtualization>disabled<\/desktop6:FileSystemWriteVirtualization>\s*<desktop6:RegistryWriteVirtualization>disabled<\/desktop6:RegistryWriteVirtualization>\s*<\/Properties>/)
  assert.ok(manifest.includes('${capabilities}'), 'capabilities still rendered by electron-builder')
  assert.ok(manifest.includes("Publisher='${publisher}'"), 'rest of the template untouched')
  assert.throws(() => storeManifestTemplate(template.replace('xmlns:rescap', 'xmlns:rc')), /rescap namespace anchor/)
  assert.throws(() => storeManifestTemplate(template.replace('</Properties>', '')), /Properties anchor/)
  assert.throws(() => storeManifestTemplate(manifest), /already declares desktop6/)
})

test('store package skips our app user model id; the EXE keeps it', () => {
  const main = `before\n${UPSTREAM_APP_USER_MODEL_ID}\nafter\n`
  const next = skipAppUserModelIdInStorePackage(main)
  assert.match(next, /if \(process\.platform === 'win32' && !process\.windowsStore\) app\.setAppUserModelId\(DESKTOP_APP_ID\)/)
  assert.ok(!next.includes(UPSTREAM_APP_USER_MODEL_ID))
  assert.throws(() => skipAppUserModelIdInStorePackage('changed'), /anchor changed/)
  // 上游当前源码里锚点唯一
  const upstream = readFileSync(new URL('../../../desktop/dsh-plugin-desktop/src/main.ts', import.meta.url), 'utf8')
  assert.equal(upstream.split(UPSTREAM_APP_USER_MODEL_ID).length, 2)
})

test('every MSIX asset is generated, including light-theme taskbar icons without a plate', () => {
  for (const name of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'Wide310x150Logo.png']) {
    assert.ok(existsSync(new URL(`./assets/windows/store/${name}`, import.meta.url)), name)
  }
  for (const size of [16, 24, 32, 48, 256]) {
    for (const form of ['unplated', 'lightunplated']) {
      const name = `Square44x44Logo.targetsize-${size}_altform-${form}.png`
      assert.ok(existsSync(new URL(`./assets/windows/store/${name}`, import.meta.url)), name)
    }
  }
})
