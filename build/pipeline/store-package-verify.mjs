// Microsoft Store 商店包（MSIX / appx）校验：读包里的 AppxManifest.xml，确认能直接上传 Partner Center。
//   node build/pipeline/store-package-verify.mjs [包路径]
// 不传路径时取 staging 的 dsh-plugin-desktop/dist/<产品名>-<版本>-x64-Store.appx。
// 检查：包标识三项与 product.json（= Partner Center）逐字一致；版本四段且末段为 0（商店要求）；
// 没有自签名（AppxSignature.p7x，商店收包后自己签）；声明 runFullTrust（插件要起子进程、调外部程序）；
// 清单引用的图标都在包里；主程序在包里。
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { productStage } from './paths.mjs'

/** 最小 ZIP 读取：只读中央目录和需要的条目（appx 就是 ZIP）。 */
export function readZip(buffer) {
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('store-package: not a zip archive')
  let count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  // ZIP64：大于 4GB 或条目超过 65535 时，真实值在 ZIP64 结尾记录里
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = end - 20
    if (buffer.readUInt32LE(locator) !== 0x07064b50) throw new Error('store-package: zip64 locator missing')
    const record = Number(buffer.readBigUInt64LE(locator + 8))
    count = Number(buffer.readBigUInt64LE(record + 32))
    offset = Number(buffer.readBigUInt64LE(record + 48))
  }
  const entries = new Map()
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('store-package: bad central directory')
    const method = buffer.readUInt16LE(offset + 10)
    let compressed = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    let local = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    // ZIP64 扩展字段里的真实大小与偏移
    let extra = offset + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra)
      const size = buffer.readUInt16LE(extra + 2)
      if (id === 0x0001) {
        let cursor = extra + 4
        if (buffer.readUInt32LE(offset + 24) === 0xffffffff) cursor += 8
        if (compressed === 0xffffffff) { compressed = Number(buffer.readBigUInt64LE(cursor)); cursor += 8 }
        if (local === 0xffffffff) local = Number(buffer.readBigUInt64LE(cursor))
      }
      extra += 4 + size
    }
    entries.set(name, { method, compressed, local })
    offset = extraEnd + commentLength
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name)
      if (!entry) return null
      const header = entry.local
      const data = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28)
      const raw = buffer.subarray(data, data + entry.compressed)
      return entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    },
  }
}

// electron-builder 的清单模板里 Publisher 用单引号（值里可能有双引号），其余用双引号：两种都认
const attribute = (xml, element, name) => {
  const match = new RegExp(`<${element}\\b[^>]*\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u').exec(xml)
  return match ? (match[1] ?? match[2]) : undefined
}
const decode = text => text?.replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'")

/**
 * @param {string} path 商店包路径
 * @param {{ name: string, version: string, windowsStore: { identityName: string, publisher: string, publisherDisplayName: string } }} product
 * @returns {{ identity: Record<string, string>, files: number }}
 */
export function verifyStorePackage(path, product) {
  if (!existsSync(path)) throw new Error(`store-package: package not found: ${path}`)
  const zip = readZip(readFileSync(path))
  const manifestBuffer = zip.read('AppxManifest.xml')
  if (!manifestBuffer) throw new Error('store-package: AppxManifest.xml missing')
  const manifest = manifestBuffer.toString('utf8')
  const store = product.windowsStore
  const identity = {
    name: decode(attribute(manifest, 'Identity', 'Name')),
    publisher: decode(attribute(manifest, 'Identity', 'Publisher')),
    version: attribute(manifest, 'Identity', 'Version'),
    architecture: attribute(manifest, 'Identity', 'ProcessorArchitecture'),
    publisherDisplayName: decode(/<PublisherDisplayName>([^<]*)<\/PublisherDisplayName>/u.exec(manifest)?.[1]),
    displayName: decode(/<Properties>[\s\S]*?<DisplayName>([^<]*)<\/DisplayName>/u.exec(manifest)?.[1]),
    executable: decode(attribute(manifest, 'Application', 'Executable')),
  }
  if (identity.name !== store.identityName) throw new Error(`store-package: Identity/Name ${identity.name} != ${store.identityName}`)
  if (identity.publisher !== store.publisher) throw new Error(`store-package: Identity/Publisher ${identity.publisher} != ${store.publisher}`)
  if (identity.publisherDisplayName !== store.publisherDisplayName) {
    throw new Error(`store-package: PublisherDisplayName ${identity.publisherDisplayName} != ${store.publisherDisplayName}`)
  }
  if (identity.version !== `${product.version}.0`) throw new Error(`store-package: Version ${identity.version} != ${product.version}.0 (Store needs four parts ending in .0)`)
  if (identity.architecture !== 'x64') throw new Error(`store-package: ProcessorArchitecture ${identity.architecture} != x64`)
  if (identity.displayName !== product.name) throw new Error(`store-package: DisplayName ${identity.displayName} != ${product.name}`)
  if (!/<rescap:Capability\s+Name="runFullTrust"/u.test(manifest)) throw new Error('store-package: runFullTrust capability missing')
  // 和 EXE 版读写同一份数据：关闭文件与注册表写入重定向，需要受限权限 unvirtualizedResources
  for (const kind of ['FileSystemWriteVirtualization', 'RegistryWriteVirtualization']) {
    if (!new RegExp(`<desktop6:${kind}>\\s*disabled\\s*</desktop6:${kind}>`, 'u').test(manifest)) {
      throw new Error(`store-package: ${kind} is not disabled; data would be redirected away from %APPDATA%\\${product.name}`)
    }
  }
  if (!/<rescap:Capability\s+Name="unvirtualizedResources"/u.test(manifest)) throw new Error('store-package: unvirtualizedResources capability missing')
  if (zip.names.includes('AppxSignature.p7x')) throw new Error('store-package: package is self-signed; upload it unsigned so the Store signs it')
  const executable = identity.executable?.replaceAll('\\', '/')
  if (!executable || !zip.names.includes(executable)) throw new Error(`store-package: executable ${identity.executable} not in package`)
  for (const logo of manifest.matchAll(/(?:Logo|Square150x150Logo|Square44x44Logo|Wide310x150Logo|Square71x71Logo|Square310x310Logo)="([^"]+)"/gu)) {
    const file = logo[1].replaceAll('\\', '/')
    const stem = file.replace(/\.png$/u, '')
    if (!zip.names.some(name => name === file || (name.startsWith(`${stem}.`) && name.endsWith('.png')))) {
      throw new Error(`store-package: logo ${logo[1]} not in package`)
    }
  }
  return { identity, files: zip.names.length }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..', '..')
  const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8')).product
  const path = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(productStage(root), 'dsh-plugin-desktop', 'dist', `${product.name}-${product.version}-x64-Store.appx`)
  const { identity, files } = verifyStorePackage(path, product)
  process.stdout.write(`store-package: ${identity.name} ${identity.version} (${identity.publisherDisplayName}) unsigned, ${files} entries: ${path}\n`)
}
