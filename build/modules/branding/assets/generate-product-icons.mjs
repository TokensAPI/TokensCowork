// 在 staging 中运行：从两个产品 PNG 生成应用、DMG 和托盘图标。
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const trayVariants = [
  ['tray-iconTemplate.png', 16], ['tray-iconTemplate@2x.png', 32],
  ['tray-icon-blue.png', 16], ['tray-icon-blue@1.25x.png', 20],
  ['tray-icon-blue@1.5x.png', 24], ['tray-icon-blue@2x.png', 32],
]
// macOS 的标准 PNG 图标块，无需 Xcode；沿用上游生成的 Dock 安全区域。
const macFrames = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
  ['ic08', 256], ['ic09', 512], ['ic10', 1024]]

/** 复用固定上游的 PNG/ICO 渲染器，补齐当前产品实际需要的派生资产。 */
export async function generateProductIcons() {
  const { default: sharp } = await import('sharp')
  const { generateMacAppIcon } = await import('./generate-mac-app-icon.mjs')
  const { generateWindowsAppIcon } = await import('./generate-windows-app-icon.mjs')
  await generateMacAppIcon()
  await generateWindowsAppIcon()
  // 原 Logo 带展示留白；托盘单独裁透明边距，16px 画布保留约 1px 安全边。
  const trayArtwork = await sharp(join(buildRoot, 'logo-mark.png'), { failOn: 'warning' })
    .trim({ background: '#00000000', threshold: 16 }).png().toBuffer()
  await Promise.all(trayVariants.map(async ([filename, size]) => {
    const artworkSize = Math.round(size * 14 / 16)
    const inset = (size - artworkSize) / 2
    await sharp(trayArtwork, { failOn: 'warning' })
      .resize({ width: artworkSize, height: artworkSize, fit: 'contain',
        background: '#00000000', kernel: sharp.kernel.lanczos3 })
      .extend({ top: Math.floor(inset), left: Math.floor(inset),
        bottom: Math.ceil(inset), right: Math.ceil(inset), background: '#00000000' })
      .png({ compressionLevel: 9, palette: false }).toFile(join(buildRoot, filename))
  }))
  const chunks = await Promise.all(macFrames.map(async ([type, size]) => {
    const png = await sharp(join(buildRoot, 'app-icon-mac.png'), { failOn: 'warning' })
      .resize(size, size).toColourspace('srgb').ensureAlpha().png().toBuffer()
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  }))
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4)
  await writeFile(join(buildRoot, 'app-icon.icns'), Buffer.concat([header, ...chunks]))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateProductIcons()
}
