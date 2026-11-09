import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { readZip, verifyStorePackage } from './store-package-verify.mjs'

const product = JSON.parse(readFileSync(new URL('../../product.json', import.meta.url), 'utf8')).product

/** 写一个最小 ZIP（deflate），足够模拟 appx 的结构。 */
function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const packed = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, packed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += 30 + nameBuffer.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const store = product.windowsStore
const manifest = (overrides = {}) => {
  const values = { name: store.identityName, publisher: store.publisher, version: `${product.version}.0`, display: store.publisherDisplayName, ...overrides }
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <Identity Name="${values.name}" ProcessorArchitecture="x64" Publisher="${values.publisher}" Version="${values.version}" />
  <Properties><DisplayName>${product.name}</DisplayName><PublisherDisplayName>${values.display}</PublisherDisplayName><Logo>assets\\StoreLogo.png</Logo></Properties>
  <Applications><Application Id="${product.name}" Executable="app\\${product.name}.exe" EntryPoint="Windows.FullTrustApplication">
    <uap:VisualElements Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png" />
  </Application></Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>`
}
const files = (extra = {}) => ({
  'AppxManifest.xml': manifest(),
  [`app/${product.name}.exe`]: 'MZ',
  'assets/StoreLogo.png': 'png',
  'assets/Square150x150Logo.scale-200.png': 'png',
  'assets/Square44x44Logo.png': 'png',
  ...extra,
})
const write = (contents) => {
  const path = join(mkdtempSync(join(tmpdir(), 'store-package-')), 'TokensCowork.appx')
  writeFileSync(path, zip(contents))
  return path
}

test('zip reader lists entries and inflates them', () => {
  const reader = readZip(zip({ 'a.txt': 'hello', 'dir/b.txt': '锡' }))
  assert.deepEqual(reader.names, ['a.txt', 'dir/b.txt'])
  assert.equal(reader.read('dir/b.txt').toString('utf8'), '锡')
  assert.equal(reader.read('missing'), null)
  assert.throws(() => readZip(Buffer.from('not a zip')), /not a zip/)
})

test('a package with the exact store identity passes', () => {
  const { identity } = verifyStorePackage(write(files()), product)
  assert.equal(identity.name, '1FCF6A48.TokensCowork')
  assert.equal(identity.publisherDisplayName, '杭州欧瑞德林经济咨询有限公司')
  assert.equal(identity.version, `${product.version}.0`)
})

test('wrong identity, version, signature, capability or missing files are rejected', () => {
  const broken = (contents, pattern) => assert.throws(() => verifyStorePackage(write(contents), product), pattern)
  broken(files({ 'AppxManifest.xml': manifest({ name: '1FCF6A48.Tokens' }) }), /Identity\/Name/)
  broken(files({ 'AppxManifest.xml': manifest({ publisher: 'CN=TokensAPI' }) }), /Identity\/Publisher/)
  broken(files({ 'AppxManifest.xml': manifest({ display: 'TokensAPI' }) }), /PublisherDisplayName/)
  broken(files({ 'AppxManifest.xml': manifest({ version: `${product.version}.1` }) }), /four parts ending in \.0/)
  broken(files({ 'AppxSignature.p7x': 'sig' }), /self-signed/)
  broken(files({ 'AppxManifest.xml': manifest().replace('<rescap:Capability Name="runFullTrust" />', '') }), /runFullTrust/)
  const noExe = files(); delete noExe[`app/${product.name}.exe`]
  broken(noExe, /executable/)
  const noLogo = files(); delete noLogo['assets/Square44x44Logo.png']
  broken(noLogo, /logo assets\\Square44x44Logo\.png/)
})
