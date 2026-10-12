// 产品图形只保留两个 PNG 源资产；SVG、托盘位图、ICO 和 ICNS 在 staging 中生成。
import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeLogo = `function FishLogo({ size = 24, className }) {
  return jsx("img", {
    src: "/tokenscowork-logo.png", width: size, height: size, className,
    alt: "", "aria-hidden": true, draggable: false
  });
}`

/** 覆盖实际 npm UI 原子组件，保留 FishLogo 的公开名称、尺寸及可访问性接口。 */
export function brandRuntimeLogo(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  const matches = [...normalized.matchAll(/function FishLogo\(\{ size = 24, className \}\) \{[\s\S]*?\n\}/gu)]
  if (matches.length !== 1) throw new Error('branding: FishLogo runtime entry changed')
  const original = matches[0][0]
  if (original === runtimeLogo) return source
  if (!original.includes('return jsx("svg",') || !original.includes('FISH_LOGO_PATH') || !original.includes('FISH_LOGO_VIEWBOX')) {
    throw new Error('branding: FishLogo runtime contract changed')
  }
  return normalized.replace(original, runtimeLogo)
}

function pngDimensions(png) {
  assert.ok(png.length >= 33
    && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && png.readUInt32BE(8) === 13 && png.toString('ascii', 12, 16) === 'IHDR', 'branding: invalid logo PNG header')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.ok(width > 0 && height > 0, 'branding: invalid logo dimensions')
  return { width, height }
}

/** SVG 仅包装原始 PNG，不重绘、调色或裁切正式 Logo。 */
export function createLogoSvg(png) {
  const { width, height } = pngDimensions(png)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/>\n</svg>\n`
}

/** 当前上游已直接使用完整 PNG 生成所有 ICO 帧，不再保留旧 SVG 改写分支。 */
export function verifyWindowsIconGenerator(source) {
  for (const anchor of ["const sourcePath = join(packageRoot, 'build', 'app-icon.png')",
    'async function renderFrame(source, size)', 'sharp(source,', '.ensureAlpha()']) {
    if (source.split(anchor).length !== 2) throw new Error('branding: Windows PNG icon renderer changed')
  }
}

/** 前端安装名称遵循产品身份；启动路径、作用域、显示模式及图标契约保持原样。 */
export function brandWebManifest(source, productName) {
  const manifest = JSON.parse(source)
  if (!['DeepSeek Harness', productName].includes(manifest.name)
    || !['DSH', productName].includes(manifest.short_name)) throw new Error('branding: frontend manifest identity changed')
  if (manifest.name === productName && manifest.short_name === productName) return source
  return JSON.stringify({ ...manifest, name: productName, short_name: productName }, null, 2) + '\n'
}

/** 产品使用平面 PNG 源资产，不能沿用上游鲸鱼的 Icon Composer 与 DMG 图标。 */
export function brandDesktopIconConfiguration(desktopPackage, productName) {
  if (desktopPackage.build?.mac?.icon !== 'build/app-icon.icon'
    || desktopPackage.build?.dmg?.icon !== 'build/app-icon.icns'
    || [desktopPackage.build?.win?.icon, desktopPackage.build?.nsis?.installerIcon, desktopPackage.build?.nsis?.uninstallerIcon]
      .some(path => path !== 'build/app-icon.ico')
    || !Array.isArray(desktopPackage.files)
    || desktopPackage.scripts?.['icons:export'] !== 'node ../scripts/export-app-icons.mjs --channel stable') {
    throw new Error('branding: Desktop icon configuration changed')
  }
  const microphone = desktopPackage.build.mac.extendInfo?.NSMicrophoneUsageDescription
  if (microphone !== 'DSH Desktop uses the microphone for voice input.') {
    throw new Error('branding: microphone usage description changed')
  }
  desktopPackage.build.mac.icon = 'build/app-icon.icns'
  desktopPackage.build.mac.extendInfo.NSMicrophoneUsageDescription = `${productName} uses the microphone for voice input.`
  desktopPackage.files = desktopPackage.files.filter(path => !['build/app-icon.icon/**', 'build/app-icon.resources.json'].includes(path))
  desktopPackage.scripts['icons:export'] = 'node scripts/generate-product-icons.mjs'
}

/** 安装依赖后应用实际使用的图形资产；所有输入和锚点通过后才写入。 */
export function applyProductLogo({ productBrandRoot, stage, productName, assertGeneratedPath }) {
  const desktop = resolve(stage, 'dsh-plugin-desktop')
  const modules = resolve(desktop, 'node_modules/@deepseek-ai')
  const frontend = resolve(modules, 'dsh-web-frontend/dist')
  const primitives = resolve(modules, 'dsh-client-ui-primitives/lib/index.js')
  const manifestPath = resolve(frontend, 'manifest.webmanifest')
  const logo = readFileSync(resolve(productBrandRoot, 'logo-mark.png'))
  const svg = createLogoSvg(logo)
  verifyWindowsIconGenerator(readFileSync(resolve(desktop, 'scripts/generate-windows-app-icon.mjs'), 'utf8'))
  const writes = new Map([
    [resolve(desktop, 'build/tray-icon.svg'), svg],
    [resolve(frontend, 'favicon.svg'), svg],
    [resolve(frontend, 'favicon-dark.svg'), svg],
    [resolve(frontend, 'tokenscowork-logo.png'), logo],
    [primitives, brandRuntimeLogo(readFileSync(primitives, 'utf8'))],
    [manifestPath, brandWebManifest(readFileSync(manifestPath, 'utf8'), productName)],
  ])
  const copies = [
    ['app-icon.png', 'build/app-icon.png'],
    ['logo-mark.png', 'build/logo-mark.png'],
    ['generate-product-icons.mjs', 'scripts/generate-product-icons.mjs'],
  ].map(([from, to]) => [resolve(productBrandRoot, from), resolve(desktop, to)])
  for (const [from, to] of copies) {
    if (!existsSync(from)) throw new Error(`branding: missing asset ${from}`)
    assertGeneratedPath(to)
  }
  const derivatives = ['app-icon-mac.png', 'app-icon.ico', 'app-icon.icns', 'app-icon.resources.json', 'app-icon.icon',
    'tray-iconTemplate.png', 'tray-iconTemplate@2x.png',
    'tray-icon-blue.png', 'tray-icon-blue@1.25x.png', 'tray-icon-blue@1.5x.png', 'tray-icon-blue@2x.png']
    .map(name => resolve(desktop, 'build', name))
  for (const path of [...writes.keys(), ...derivatives]) assertGeneratedPath(path)
  for (const [from, to] of copies) cpSync(from, to)
  for (const [path, content] of writes) {
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(content))) writeFileSync(path, content)
  }
  for (const path of derivatives) rmSync(path, { recursive: true, force: true })
}

/** 依赖安装后生成一次，开发和发布均由同一配置阶段调用。 */
export async function generateProductIcons(stage) {
  const generator = await import(pathToFileURL(resolve(stage, 'dsh-plugin-desktop/scripts/generate-product-icons.mjs')).href)
  await generator.generateProductIcons()
}

/** 同时验收宿主、已安装前端和 UI 组件；不能只检查未被编译的 Harness 源码。 */
export function verifyProductLogo({ desktopRoot, productName }) {
  const read = path => readFileSync(resolve(desktopRoot, path))
  const logo = read('build/logo-mark.png')
  const svg = Buffer.from(createLogoSvg(logo))
  for (const name of ['app-icon.png', 'logo-mark.png']) {
    assert.ok(read(`build/${name}`).equals(readFileSync(resolve(import.meta.dirname, 'assets', name))), `branding: source asset differs: ${name}`)
  }
  const frontend = 'node_modules/@deepseek-ai/dsh-web-frontend/dist'
  for (const path of ['build/tray-icon.svg', `${frontend}/favicon.svg`, `${frontend}/favicon-dark.svg`]) {
    assert.ok(read(path).equals(svg), `branding: incorrect logo ${path}`)
  }
  assert.ok(read(`${frontend}/tokenscowork-logo.png`).equals(logo), 'branding: frontend logo differs from product asset')
  const client = read('node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js').toString('utf8')
  assert.equal(brandRuntimeLogo(client), client, 'branding: UI runtime retains upstream logo')
  const manifest = read(`${frontend}/manifest.webmanifest`).toString('utf8')
  assert.equal(brandWebManifest(manifest, productName), manifest, 'branding: frontend install identity is incorrect')
}

/** 构建门禁必须检查所有派生资产，不能让打包器捡到残留的上游图标。 */
export function verifyGeneratedProductIcons(desktopRoot) {
  const read = name => readFileSync(resolve(desktopRoot, 'build', name))
  const ico = read('app-icon.ico')
  assert.ok(ico.length > 6 && ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 16,
    'branding: incomplete Windows icon')
  const icns = read('app-icon.icns')
  assert.ok(icns.length > 8 && icns.toString('ascii', 0, 4) === 'icns' && icns.readUInt32BE(4) === icns.length,
    'branding: incomplete macOS icon')
  const macSizes = new Map([['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
    ['ic08', 256], ['ic09', 512], ['ic10', 1024]])
  for (let offset = 8; offset < icns.length;) {
    assert.ok(offset + 8 <= icns.length, 'branding: truncated macOS icon frame')
    const type = icns.toString('ascii', offset, offset + 4)
    const length = icns.readUInt32BE(offset + 4)
    const size = macSizes.get(type)
    assert.ok(size && length > 8 && offset + length <= icns.length, `branding: invalid macOS icon frame ${type}`)
    const png = icns.subarray(offset + 8, offset + length)
    const { width, height } = pngDimensions(png)
    assert.ok(width === size && height === size, `branding: incorrect macOS frame ${type}`)
    macSizes.delete(type)
    offset += length
  }
  assert.equal(macSizes.size, 0, 'branding: macOS icon sizes are missing')
  const sizes = [['app-icon-mac.png', 1024], ['tray-iconTemplate.png', 16], ['tray-iconTemplate@2x.png', 32],
    ['tray-icon-blue.png', 16], ['tray-icon-blue@1.25x.png', 20], ['tray-icon-blue@1.5x.png', 24], ['tray-icon-blue@2x.png', 32]]
  for (const [name, size] of sizes) {
    const png = read(name)
    const { width, height } = pngDimensions(png)
    assert.ok(width === size && height === size, `branding: incorrect icon dimensions: ${name}`)
  }
}
