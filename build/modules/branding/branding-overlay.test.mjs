import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { brandDesktopMain, brandDesktopProductIdentity, brandDesktopCertificate, alignSidebarAccountRow, brandDesktopPatch, brandNativeCopyText, brandProfileBootTerminalCheck, nativeCopyPaths, verifyDesktopCertificateBranding } from './branding-overlay.mjs'
import { brandInstalledRuntime, verifyInstalledRuntimeBranding, hideUpstreamCloudEntry, hideUpstreamFeedbackEntry, hideUpstreamAccountSection } from './branding-runtime-overlay.mjs'
import { applyProductLogo, verifyProductLogo, brandDesktopIconConfiguration, brandRuntimeLogo, brandWebManifest, createLogoSvg, verifyWindowsIconGenerator } from './branding-assets.mjs'
import { brandMarketCopy } from '../market/market-source-overlay.mjs'
import { AnchorError } from '../../pipeline/anchors.mjs'

const productName = 'TokensCowork'

test('all selected native surfaces use product copy without altering technical identifiers', () => {
  for (const parts of nativeCopyPaths) {
    const path = parts.join('/')
    const original = readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop', ...parts), 'utf8')
    const branded = brandNativeCopyText(original, path, productName)
    assert.equal(branded, original.replaceAll('DSH Desktop', productName).replaceAll('DeepSeek Harness', productName)
      .replaceAll('DSH Terminal', productName + ' Terminal').replaceAll('DSH 终端', productName + ' 终端'))
    assert.doesNotMatch(branded, /DSH Desktop|DeepSeek Harness|DSH Terminal|DSH 终端/u)
    assert.equal(brandNativeCopyText(branded, path, productName), branded)
  }
  assert.throws(() => brandNativeCopyText('upstream changed', 'src/x.ts', productName), /no longer carries/)
})

test('market installation and restart copy is branded in both languages', () => {
  const original = readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-community-market/src/client/locales.ts'), 'utf8')
  const result = brandMarketCopy(original, productName)
  assert.ok(result.includes('请确认 TokensCowork 验证的 npm 包、版本和目标配置。'))
  // 2.0.18 起操作即时生效，只剩需重启时的提示条。
  assert.ok(result.includes('已保存，重启 TokensCowork 后生效。'))
  assert.ok(result.includes('after TokensCowork restarts'))
  assert.doesNotMatch(result, /DSH Desktop|DeepSeek Harness|DSH Terminal|DSH 终端/u)
  assert.equal(brandMarketCopy(result, productName), result)
  assert.equal(brandMarketCopy('dsh-community-market /api/dsh @deepseek-ai/dsh', productName), 'dsh-community-market /api/dsh @deepseek-ai/dsh')
})

test('certificate branding accepts monolithic and lazy-loaded runtime chunks', () => {
  const certificate = `const CA_COMMON_NAME = "${productName} Local CA";`
  const main = 'async function setup() { return import("./lan-https-certificate-ABC.js"); }'
  assert.doesNotThrow(() => verifyDesktopCertificateBranding(certificate, productName))
  assert.doesNotThrow(() => verifyDesktopCertificateBranding([main, certificate].join('\n'), productName))
  assert.throws(() => verifyDesktopCertificateBranding(main, productName), /missing the product/)
})

test('certificate branding rejects missing, wrong, and mixed brands in any chunk', () => {
  const product = `const name = "${productName} Local CA";`
  const upstream = 'const name = "DeepSeek Harness Desktop Local CA";'
  for (const source of ['', upstream, 'const name = "OtherProduct Local CA";']) {
    assert.throws(() => verifyDesktopCertificateBranding(source, productName), /missing the product/)
  }
  for (const chunks of [[product, upstream], [upstream, product]]) {
    assert.throws(() => verifyDesktopCertificateBranding(chunks.join('\n'), productName), /retains upstream/)
  }
})
// 0.2.1 起 app-boot 的 "implementation checkout is at" 整句删除，不再有 boot 锚点；GUI 句只剩一处。
const guiAnchor = 'DeepSeek Harness Web GUI'
const guiBranded = `${productName} Web GUI`
const codingStandard = 'You are a coding agent powered by the {{model}} model.'
const persona = `You are a versatile AI assistant inside ${productName}, powered by the {{model}} model. You handle coding, research, writing, and everyday tasks alike.`
const cloudEntry = `ctx.effect(() => services.slots.inject("sidebar.footer.action", () => services.slots.register({
  name: "sidebar.footer.action", id: "agents-anywhere-next", order: 26,
  locale: LOCALE_NS, label: () => t("远程控制"), inject: () => ({ host })
}, ConnectionEntry)), "agentsAnywhereOnboarding.sidebar");`

// 造一份最小的"已装好的依赖树",只含被品牌化的那几个文件。
function makeStage(files) {
  const stage = mkdtempSync(resolve(tmpdir(), 'branding-overlay-'))
  const modules = resolve(stage, 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai')
  const write = (path, text) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text) }
  write(resolve(modules, '../@agents-anywhere/dsh-bridge-next/lib/client.js'), cloudEntry)
  write(resolve(modules, 'dsh-client-ui-directory-picker-browse/lib/client.js'), 'DSH Desktop native directory picker is unavailable; DSH Desktop directory validation is unavailable')
  write(resolve(modules, 'dsh-web-app', 'lib', 'index.js'), files.gui)
  write(resolve(modules, 'dsh-client-ui-layout', 'lib', 'client.js'), files.title)
  write(resolve(modules, 'dsh-web-frontend', 'dist', 'index.html'), files.html)
  for (const file of ['presets/standard.patch.yml', 'presets/ptc.patch.yml', 'presets/cordis.patch.yml', 'cordis.patch.yml']) {
    const original = readFileSync(resolve(import.meta.dirname, '../../../desktop/deepseek-harness/packages/bundle/web-app', file), 'utf8')
    write(resolve(modules, 'dsh-web-app', file), files.standard === persona ? original.replace(codingStandard, persona) : original)
  }
  return { stage, guiPath: resolve(modules, 'dsh-web-app', 'lib', 'index.js') }
}

const pristine = () => ({
  gui: `x ${guiAnchor} y`,
  title: 'const productTitle = "DeepSeek Harness";',
  html: '<title>DeepSeek Harness</title>',
  standard: codingStandard,
})

const branded = () => ({
  gui: `x ${guiBranded} y`,
  title: `const productTitle = "${productName}";`,
  html: `<title>${productName}</title>`,
  standard: persona,
})

test('current PNG renderer consumes the replaced product artwork without recoloring it', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop/scripts/generate-windows-app-icon.mjs'), 'utf8')
  assert.doesNotThrow(() => verifyWindowsIconGenerator(source))
  assert.throws(() => verifyWindowsIconGenerator(source.replace('app-icon.png', 'official.png')), /renderer changed/)
})

test('current web-app declarative presets retain their composition and use the product persona', () => {
  const { stage } = makeStage(pristine())
  try {
    const root = resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-web-app')
    mkdirSync(resolve(root, 'presets'), { recursive: true })
    const files = ['presets/standard.patch.yml', 'presets/ptc.patch.yml', 'presets/cordis.patch.yml', 'cordis.patch.yml']
    const originals = files.map(file => readFileSync(resolve(import.meta.dirname, '../../../desktop/deepseek-harness/packages/bundle/web-app', file), 'utf8'))
    files.forEach((file, index) => writeFileSync(resolve(root, file), originals[index]))
    brandInstalledRuntime({ stage, productName })
    files.forEach((file, index) => assert.equal(readFileSync(resolve(root, file), 'utf8'), originals[index].replace(codingStandard, persona)))
    brandInstalledRuntime({ stage, productName })
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('brands a freshly installed dependency tree', () => {
  const { stage, guiPath } = makeStage(pristine())
  try {
    brandInstalledRuntime({ stage, productName })
    assert.match(readFileSync(guiPath, 'utf8'), new RegExp(guiBranded))
    const preset = readFileSync(resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8')
    assert.ok(preset.includes(persona))
    const modules = resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai')
    assert.equal(readFileSync(resolve(modules, 'dsh-client-ui-layout/lib/client.js'), 'utf8'), branded().title)
    assert.equal(readFileSync(resolve(modules, 'dsh-web-frontend/dist/index.html'), 'utf8'), branded().html)
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('new Desktop bootstrap does not receive a duplicate existsSync import', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop/src/main.ts'), 'utf8')
  const result = brandDesktopMain(source, ['TokensHarness'])
  const fsImports = result.match(/import \{[^}]+\} from 'node:fs'/gu) ?? []
  assert.equal(fsImports.join('\n').match(/\bexistsSync\b/gu)?.length, 1)
  assert.ok(result.includes('migrateLegacyUserData()'))
})

// node_modules 跨装配保留(见 build/pipeline/staging-prepare.mjs),所以本函数一定会再次
// 撞上自己上一轮改过的文件。锚点消失但替换结果在位 = 已生效,不是上游漂移。
test('second assembly over a preserved tree is a no-op, not a failure', () => {
  const { stage, guiPath } = makeStage(branded())
  try {
    const before = statSync(guiPath).mtimeMs
    brandInstalledRuntime({ stage, productName })
    assert.equal(statSync(guiPath).mtimeMs, before, '已品牌化的文件不该被重写')
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('upstream drift still fails loudly', () => {
  const files = branded()
  files.gui = 'x Something Else Web GUI y'
  const { stage } = makeStage(files)
  try {
    assert.throws(() => brandInstalledRuntime({ stage, productName }), /品牌锚点/)
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('an extra upstream occurrence still fails loudly', () => {
  const files = pristine()
  files.gui = `${guiAnchor} a; ${guiAnchor} b`
  const { stage } = makeStage(files)
  try {
    assert.throws(() => brandInstalledRuntime({ stage, productName }), /出现 2 次,预期 1 次/)
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('client title branding escapes JavaScript and HTML and detects upstream drift', () => {
  const { stage } = makeStage(pristine())
  const modules = resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai')
  const titlePath = resolve(modules, 'dsh-client-ui-layout/lib/client.js')
  try {
    const name = 'Cowork "R&D" <test>'
    brandInstalledRuntime({ stage, productName: name })
    assert.equal(new Function(readFileSync(titlePath, 'utf8') + 'return productTitle')(), name)
    assert.equal(readFileSync(resolve(modules, 'dsh-web-frontend/dist/index.html'), 'utf8'), '<title>Cowork "R&amp;D" &lt;test&gt;</title>')
    brandInstalledRuntime({ stage, productName: name })
    writeFileSync(titlePath, 'const productTitle = newBrandApi();')
    assert.throws(() => brandInstalledRuntime({ stage, productName: name }), /品牌锚点/)
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('hides only the upstream cloud sidebar registration, retaining market and runtime work', () => {
  const source = `reportSelection(); ${cloudEntry}\nservices.slots.register({ id: 'market' });`
  const patched = hideUpstreamCloudEntry(source)
  const registered = []
  let reported = 0
  new Function('reportSelection', 'services', patched)(() => { reported++ }, {
    slots: { register: entry => registered.push(entry.id) },
  })
  assert.deepEqual(registered, ['market'])
  assert.equal(reported, 1)
  assert.equal(hideUpstreamCloudEntry(patched), patched)
  assert.throws(() => hideUpstreamCloudEntry(cloudEntry + cloudEntry), /changed/)
  assert.throws(() => hideUpstreamCloudEntry(cloudEntry.replace('order: 26', 'order: 27')), /changed/)
  assert.throws(() => hideUpstreamCloudEntry(patched + cloudEntry), /incomplete/)
})

test('localized upstream cloud entry hides the same sidebar slot and keeps settings registration', () => {
  const localized = cloudEntry
  const source = 'ctx.effect(() => registerPluginSettings(services.slots, host), "settings");\n' + localized
  const result = hideUpstreamCloudEntry(source)
  assert.ok(result.includes('registerPluginSettings'))
  assert.ok(!result.includes('id: "agents-anywhere-next"'))
  assert.equal(hideUpstreamCloudEntry(result), result)
})

// 针对实际运行时、失败路径与数据迁移补行为测试；不引入测试专用目录结构。
function temporary(t, prefix) {
  const path = mkdtempSync(resolve(tmpdir(), prefix))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function writeFixture(path, content) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
}
const assetRoot = resolve(import.meta.dirname, 'assets')
const fishLogo = 'function FishLogo({ size = 24, className }) {\n  return jsx("svg", { viewBox: FISH_LOGO_VIEWBOX, children: FISH_LOGO_PATH });\n}'

test('source identity, certificate and migration reject missing and duplicate anchors', () => {
  const read = file => readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop', file), 'utf8').replaceAll('\r\n', '\n')
  const cases = [
    [read('src/product-identity.ts'), source => brandDesktopProductIdentity(source, { name: productName, appId: 'app.tokens.cowork' }), "productName: 'DSH Desktop',"],
    [read('src/lan-https-certificate.ts'), source => brandDesktopCertificate(source, productName), "const CA_COMMON_NAME = 'DeepSeek Harness Desktop Local CA'"],
    [read('src/main.ts'), source => brandDesktopMain(source, ['TokensHarness']), 'const PRODUCT_NAME = DESKTOP_PRODUCT_NAME'],
  ]
  for (const [source, transform, anchor] of cases) {
    assert.doesNotThrow(() => transform(source))
    assert.throws(() => transform(source.replace(anchor, 'upstream changed')), AnchorError)
    assert.throws(() => transform(source + '\n' + anchor), AnchorError)
  }
  const patch = brandDesktopPatch('- id: desktop', productName)
  assert.throws(() => brandDesktopPatch(patch, productName), /applied twice/)
})

test('runtime verification is read-only and detects missing persona before any partial writes', t => {
  const { stage, guiPath } = makeStage(pristine())
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  const before = readFileSync(guiPath, 'utf8')
  assert.throws(() => verifyInstalledRuntimeBranding({ stage, productName }), /missing/)
  assert.equal(readFileSync(guiPath, 'utf8'), before)
  const presetPath = resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')
  writeFileSync(presetPath, 'Unknown persona')
  assert.throws(() => brandInstalledRuntime({ stage, productName }), /品牌锚点/)
  assert.equal(readFileSync(guiPath, 'utf8'), before)
  writeFileSync(presetPath, codingStandard + codingStandard)
  assert.throws(() => brandInstalledRuntime({ stage, productName }), /品牌锚点/)
  writeFileSync(presetPath, readFileSync(resolve(import.meta.dirname, '../../../desktop/deepseek-harness/packages/bundle/web-app/cordis.patch.yml')))
  brandInstalledRuntime({ stage, productName })
  verifyInstalledRuntimeBranding({ stage, productName })
})

test('runtime logo preserves caller size and class and uses the served product PNG', () => {
  const branded = brandRuntimeLogo(fishLogo)
  const render = new Function('jsx', branded + '\nreturn FishLogo')((tag, props) => ({ tag, props }))
  assert.deepEqual(render({ size: 40, className: 'sidebar' }), {
    tag: 'img', props: { src: '/tokenscowork-logo.png', width: 40, height: 40, className: 'sidebar', alt: '', 'aria-hidden': true, draggable: false },
  })
  assert.equal(render({}).props.width, 24)
  assert.equal(brandRuntimeLogo(branded), branded)
  for (const source of ['', fishLogo + fishLogo, fishLogo.replace('FISH_LOGO_PATH', 'upstreamChanged')]) {
    assert.throws(() => brandRuntimeLogo(source), /changed/)
  }
})

test('SVG wraps the exact canonical PNG and rejects invalid headers and dimensions', () => {
  const png = readFileSync(resolve(assetRoot, 'logo-mark.png'))
  const svg = createLogoSvg(png)
  assert.match(svg, /viewBox="0 0 480 480"/)
  assert.ok(Buffer.from(svg.match(/base64,([^"]+)/)[1], 'base64').equals(png))
  for (const invalid of [Buffer.alloc(0), png.subarray(0, 20), Buffer.alloc(33)]) {
    assert.throws(() => createLogoSvg(invalid), /invalid logo PNG header/)
  }
  const zeroSize = Buffer.from(png)
  zeroSize.writeUInt32BE(0, 16)
  assert.throws(() => createLogoSvg(zeroSize), /invalid logo dimensions/)
})

test('frontend manifest changes only install identity and checks its known contract', () => {
  const manifest = { name: 'DeepSeek Harness', short_name: 'DSH', scope: './', start_url: './', display: 'fullscreen', icons: [{ src: 'favicon.svg' }] }
  const result = brandWebManifest(JSON.stringify(manifest), productName)
  assert.deepEqual(JSON.parse(result), { ...manifest, name: productName, short_name: productName })
  assert.equal(brandWebManifest(result, productName), result)
  assert.throws(() => brandWebManifest(JSON.stringify({ ...manifest, name: 'Unknown' }), productName), /identity changed/)
})

test('assets cover installed frontend and UI and stop all writes when an anchor drifts', t => {
  const stage = temporary(t, 'branding-assets-')
  const desktopRoot = resolve(stage, 'dsh-plugin-desktop')
  const frontend = resolve(desktopRoot, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')
  const primitives = resolve(desktopRoot, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js')
  writeFixture(resolve(desktopRoot, 'scripts/generate-windows-app-icon.mjs'),
    readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop/scripts/generate-windows-app-icon.mjs')))
  writeFixture(primitives, fishLogo)
  const manifest = resolve(frontend, 'manifest.webmanifest')
  writeFixture(manifest, '{"name":"Unknown","short_name":"DSH"}')
  mkdirSync(resolve(desktopRoot, 'build'), { recursive: true })
  const options = { stage, productName, productBrandRoot: assetRoot,
    assertGeneratedPath: path => assert.ok(path.startsWith(stage + sep)) }
  assert.throws(() => applyProductLogo(options), /identity changed/)
  assert.equal(existsSync(resolve(desktopRoot, 'build/app-icon.png')), false)
  assert.equal(readFileSync(primitives, 'utf8'), fishLogo)
  writeFixture(manifest, '{"name":"DeepSeek Harness","short_name":"DSH","start_url":"./"}')
  applyProductLogo(options)
  verifyProductLogo({ desktopRoot, productName })
  const favicon = resolve(frontend, 'favicon.svg')
  const mtime = statSync(favicon).mtimeMs
  applyProductLogo(options)
  assert.equal(statSync(favicon).mtimeMs, mtime)
  assert.equal(existsSync(resolve(stage, 'deepseek-harness')), false)
  writeFixture(resolve(frontend, 'tokenscowork-logo.png'), 'wrong logo')
  assert.throws(() => verifyProductLogo({ desktopRoot, productName }), /differs/)
})

// 执行真正注入的迁移代码：Electron app 为最小替身，文件操作在真实临时目录完成。
function migration(t, overrides = {}) {
  const appData = temporary(t, 'branding-migration-')
  const paths = { appData }
  const app = { isPackaged: false, getPath: name => paths[name], setPath: (name, value) => { paths[name] = value } }
  const source = readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop/src/main.ts'), 'utf8').replaceAll('\r\n', '\n')
  const main = brandDesktopMain(source, ['TokensHarness', 'TokensOld'])
  const start = main.indexOf('function migrateLegacyUserData(): void')
  const end = main.indexOf('\nasync function run(): Promise<void>', start)
  const helper = stripTypeScriptTypes(main.slice(start, end))
  const run = new Function('app', 'process', 'join', 'existsSync', 'renameSync', 'cpSync', 'rmSync', 'randomUUID', 'PRODUCT_NAME', 'LEGACY_PRODUCT_NAMES',
    helper + '\nreturn migrateLegacyUserData')(
    app, { env: overrides.env ?? {} }, join, existsSync, overrides.renameSync ?? renameSync,
    overrides.cpSync ?? cpSync, rmSync, () => 'test', productName, ['TokensHarness', 'TokensOld'])
  return { appData, paths, app, run }
}

test('migration selects the first legacy directory and never replaces current data', t => {
  const { appData, paths, run } = migration(t)
  writeFixture(join(appData, 'TokensHarness/state.json'), 'old state')
  writeFixture(join(appData, 'TokensOld/state.json'), 'older state')
  run()
  assert.equal(paths.userData, join(appData, productName))
  assert.equal(readFileSync(join(paths.userData, 'state.json'), 'utf8'), 'old state')
  assert.equal(existsSync(join(appData, 'TokensHarness')), false)
  run()
  assert.equal(readFileSync(join(appData, 'TokensOld/state.json'), 'utf8'), 'older state')
})

test('migration fallback delivers a complete copy and retains the original', t => {
  const { appData, paths, run } = migration(t, {
    renameSync: (from, to) => {
      if (from.endsWith('TokensHarness')) throw new Error('EXDEV')
      renameSync(from, to)
    },
  })
  writeFixture(join(appData, 'TokensHarness/nested/state.json'), 'old state')
  run()
  assert.equal(readFileSync(join(paths.userData, 'nested/state.json'), 'utf8'), 'old state')
  assert.equal(readFileSync(join(appData, 'TokensHarness/nested/state.json'), 'utf8'), 'old state')
  assert.equal(readdirSync(appData).some(name => name.includes('-migration-')), false)
})

test('failed migration removes partial copy, retains old data and aborts empty startup', t => {
  const { appData, paths, run } = migration(t, {
    renameSync: () => { throw new Error('EXDEV') },
    cpSync: (_from, to) => { writeFixture(join(to, 'partial'), 'partial'); throw new Error('copy denied') },
  })
  writeFixture(join(appData, 'TokensHarness/state.json'), 'old state')
  assert.throws(run, /original directory was retained/)
  assert.equal(readFileSync(join(appData, 'TokensHarness/state.json'), 'utf8'), 'old state')
  assert.deepEqual(readdirSync(appData), ['TokensHarness'])
  assert.equal(paths.userData, undefined)
})

test('development app-data override isolates startup and packaged apps ignore it', t => {
  const sandbox = temporary(t, 'branding-dev-data-')
  const dev = migration(t, { env: { TOKENS_COWORK_DEV_APP_DATA: sandbox } })
  dev.run()
  assert.equal(dev.paths.appData, sandbox)
  assert.equal(dev.paths.sessionData, join(sandbox, productName))
  const packaged = migration(t, { env: { TOKENS_COWORK_DEV_APP_DATA: sandbox } })
  packaged.app.isPackaged = true
  packaged.run()
  assert.equal(packaged.paths.appData, packaged.appData)
  assert.equal(packaged.paths.userData, join(packaged.appData, productName))
  assert.equal(packaged.paths.sessionData, undefined)
})

test('Desktop icon policy uses product ICNS and retains signing and packaging options', () => {
  const desktop = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop/package.json'), 'utf8'))
  const before = structuredClone(desktop)
  brandDesktopIconConfiguration(desktop, productName)
  assert.equal(desktop.build.mac.icon, 'build/app-icon.icns')
  assert.equal(desktop.build.dmg.icon, 'build/app-icon.icns')
  assert.equal(desktop.build.mac.extendInfo.NSMicrophoneUsageDescription, productName + ' uses the microphone for voice input.')
  assert.equal(desktop.build.mac.entitlements, before.build.mac.entitlements)
  assert.equal(desktop.build.mac.hardenedRuntime, before.build.mac.hardenedRuntime)
  assert.equal(desktop.build.mac.notarize, before.build.mac.notarize)
  assert.deepEqual(desktop.build.win, before.build.win)
  assert.equal(desktop.scripts['icons:export'], 'node scripts/generate-product-icons.mjs')
  assert.ok(!desktop.files.includes('build/app-icon.icon/**'))
  before.build.mac.icon = 'unknown.icon'
  assert.throws(() => brandDesktopIconConfiguration(before, productName), /configuration changed/)
})

test('Profile boot check looks for the branded terminal tray entry produced by native copy branding', () => {
  const read = file => readFileSync(resolve(import.meta.dirname, '../../../desktop/dsh-plugin-desktop', file), 'utf8').replaceAll('\r\n', '\n')
  const tray = brandNativeCopyText(read('src/tray-locale.ts'), 'src/tray-locale.ts', productName)
  const brandedLabel = /openTerminal: \(\) => '([^']+)'/u.exec(tray)[1]
  const branded = brandProfileBootTerminalCheck(read('scripts/verify-profile-boot.mjs'), productName)
  assert.ok(branded.includes(`item.label() === '${brandedLabel}'`))
  assert.throws(() => brandProfileBootTerminalCheck(branded, productName), AnchorError)
})

test('account menu loses only the upstream feedback entry and stays valid', () => {
  // Shape of the compiled DSH 0.2 AccountMenu item list (tab-indented as published).
  const source = [
    'items: [',
    '\t\t{',
    '\t\t\tid: "settings",',
    '\t\t\tlabel: t("settings"),',
    '\t\t\ticon: icon("settings")',
    '\t\t},',
    '\t\t{',
    '\t\t\tid: "contact",',
    '\t\t\tlabel: t("contactUs"),',
    '\t\t\ticon: (0, jsx)(Icons.IconPaperPlaneOutlineMedium, { size: 16 })',
    '\t\t},',
    '\t\t...signedIn ? [{ id: "signout" }] : [{ id: "signin" }]',
    ']',
  ].join('\n')
  const patched = hideUpstreamFeedbackEntry(source)
  const items = new Function('t', 'icon', 'jsx', 'Icons', 'signedIn', `return { ${patched} }.items`)(key => key, () => null, () => null, {}, false)
  assert.deepEqual(items.map(item => item.id), ['settings', 'signin'])
  assert.equal(hideUpstreamFeedbackEntry(patched), patched)
  assert.throws(() => hideUpstreamFeedbackEntry(source.replace('id: "contact"', 'id: "feedback"')), AnchorError)
})

test('the upstream DeepSeek account settings page is never registered, even when signed in', () => {
  // Shape of the compiled DSH 0.2 account settings-section registration.
  const source = [
    'const update = () => {',
    '\tif (snapshot.view?.status === "credential-stored") unregister ??= ctx.slots.register({',
    '\t\tname: "settings.section",',
    '\t\tid: "account",',
    '\t\torder: -10',
    '\t}, AccountSection);',
    '\telse {',
    '\t\tunregister?.();',
    '\t\tunregister = void 0;',
    '\t}',
    '};',
  ].join('\n')
  const patched = hideUpstreamAccountSection(source)
  const registered = []
  new Function('snapshot', 'ctx', 'AccountSection', `let unregister; ${patched}; update()`)(
    { view: { status: 'credential-stored' } }, { slots: { register: options => { registered.push(options.id); return () => {} } } }, null)
  assert.deepEqual(registered, [])
  assert.equal(hideUpstreamAccountSection(patched), patched)
  assert.throws(() => hideUpstreamAccountSection(source.replace('id: "account"', 'id: "profile"')), AnchorError)
})

test('the signed-in sidebar account row lines up with the Plugin Market row', () => {
  const product = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../product.json'), 'utf8'))
  const plugin = product.plugins.find(item => item.id === 'tokens-login')
  const source = readFileSync(resolve(import.meta.dirname, '../../..', plugin.path, 'dsh/client.js'), 'utf8').replaceAll('\r\n', '\n')
  const patched = alignSidebarAccountRow(source)
  const added = patched.split('\n').filter(line => !source.includes(line))
  assert.equal(added.length, 2)
  assert.ok(added.every(line => line.includes('[data-collapsed=false][data-signed-out=false]')))
  // Avatar centre and text start match the market row: 16px icon centred at 14px, text from 30px.
  const padding = 4, avatar = 20, gap = 6
  assert.equal(padding + avatar / 2, 14)
  assert.equal(padding + avatar + gap, 30)
  assert.throws(() => alignSidebarAccountRow(source.replace("'.tkl-label{", "'.tkl-name{")), AnchorError)
})
