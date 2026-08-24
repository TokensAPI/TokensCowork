/** Generate tray bitmaps by resizing the product Logo without recoloring it. */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const sourcePath = join(buildRoot, 'logo-mark.png')

const variants = [
  ['tray-iconTemplate.png', 16],
  ['tray-iconTemplate@2x.png', 32],
  ['tray-icon-blue.png', 16],
  ['tray-icon-blue@1.25x.png', 20],
  ['tray-icon-blue@1.5x.png', 24],
  ['tray-icon-blue@2x.png', 32],
]

await Promise.all(variants.map(async ([filename, size]) => {
  await sharp(sourcePath, { failOn: 'warning' })
    .resize({ width: size, height: size, fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toFile(join(buildRoot, filename))
}))
