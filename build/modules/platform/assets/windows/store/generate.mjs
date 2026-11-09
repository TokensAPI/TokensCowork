// 生成 Microsoft Store（MSIX）包里的图标：从品牌 app-icon.png（1024×1024）缩放，透明底、居中、留边。
// 产物与本文件同目录，入库；electron-builder 打 appx 时从 dsh-plugin-desktop/build/appx/ 读取（platform.windows-store-assets 复制过去）。
// 换 Logo 后重跑：node build/modules/platform/assets/windows/store/generate.mjs
// 名称是 electron-builder appx 目标认的固定文件名；.scale-200 / .targetsize-*_altform-unplated 是 Windows 按 DPI、任务栏选用的变体。
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..', '..', '..', '..')
const require = createRequire(join(root, '.build', 'desktop', 'dsh-plugin-desktop', 'package.json'))
const sharp = require('sharp')
const source = resolve(here, '..', '..', '..', '..', 'branding', 'assets', 'app-icon.png')

/** [文件名, 宽, 高, 图标占短边的比例] */
const outputs = [
  ['StoreLogo.png', 50, 50, 0.92],
  ['StoreLogo.scale-200.png', 100, 100, 0.92],
  ['Square44x44Logo.png', 44, 44, 0.92],
  ['Square44x44Logo.scale-200.png', 88, 88, 0.92],
  // 任务栏、开始菜单列表、文件资源管理器用的无底板图标：unplated 给深色主题，lightunplated 给浅色主题。
  // 浅色任务栏缺 lightunplated 时 Windows 11 会退回带底板的图标，底板填系统强调色（蓝底）。
  ...[16, 20, 24, 30, 32, 36, 40, 48, 64, 256].flatMap(size => [
    [`Square44x44Logo.targetsize-${size}_altform-unplated.png`, size, size, 1],
    [`Square44x44Logo.targetsize-${size}_altform-lightunplated.png`, size, size, 1],
  ]),
  ['SmallTile.png', 71, 71, 0.7],
  ['Square150x150Logo.png', 150, 150, 0.62],
  ['Square150x150Logo.scale-200.png', 300, 300, 0.62],
  ['Wide310x150Logo.png', 310, 150, 0.62],
  ['Wide310x150Logo.scale-200.png', 620, 300, 0.62],
  ['LargeTile.png', 310, 310, 0.62],
]

for (const [name, width, height, ratio] of outputs) {
  const size = Math.round(Math.min(width, height) * ratio)
  const icon = await sharp(source).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: icon, gravity: 'center' }]).png({ compressionLevel: 9 }).toFile(join(here, name))
  console.log(name, `${width}x${height}`)
}
