import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { brandDesktopMain, brandInstalledRuntimePrompts, hideUpstreamCloudEntry } from './branding-overlay.mjs'

const productName = 'TokensCowork'
const bootAnchor = 'The DeepSeek Harness implementation checkout is at'
const bootBranded = `The ${productName} implementation checkout is at`
const guiAnchor = 'DeepSeek Harness Web GUI'
const codingStandard = 'You are a coding agent powered by the {{model}} model.'
const codingCordis = 'You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness.'
const persona = `You are a versatile AI assistant inside ${productName}, powered by the {{model}} model. You handle coding, research, writing, and everyday tasks alike.`
const cloudEntry = `ctx.effect(() => services.slots.inject("sidebar.footer.action", () => services.slots.register({
  name: "sidebar.footer.action", id: "agents-anywhere-next", order: 26,
  label: () => "手机连接", inject: () => ({ host })
}, ConnectionEntry)), "agentsAnywhereOnboarding.sidebar");`

// 造一份最小的"已装好的依赖树",只含被品牌化的那几个文件。
function makeStage(files) {
  const stage = mkdtempSync(resolve(tmpdir(), 'branding-overlay-'))
  const modules = resolve(stage, 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai')
  const write = (path, text) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text) }
  write(resolve(modules, '../@agents-anywhere/dsh-bridge-next/lib/client.js'), cloudEntry)
  write(resolve(modules, 'dsh-app-boot', 'lib', 'index.js'), files.boot)
  write(resolve(modules, 'dsh-web-app', 'lib', 'index.js'), files.gui)
  write(resolve(modules, 'dsh-client-ui-layout', 'lib', 'client.js'), files.title)
  write(resolve(modules, 'dsh-web-frontend', 'dist', 'index.html'), files.html)
  for (const preset of ['standard', 'ptc', 'cordis']) {
    write(resolve(modules, 'dsh-agent-presets', 'presets', preset, 'agent.cordis.yml'), files[preset])
  }
  return { stage, bootPath: resolve(modules, 'dsh-app-boot', 'lib', 'index.js') }
}

const pristine = () => ({
  boot: `x ${bootAnchor} y`,
  gui: `${guiAnchor} ... ${guiAnchor}`,
  title: 'const productTitle = "DeepSeek Harness";',
  html: '<title>DeepSeek Harness</title>',
  standard: codingStandard,
  ptc: codingStandard,
  cordis: codingCordis,
})

const branded = () => ({
  boot: `x ${bootBranded} y`,
  gui: `${productName} Web GUI ... ${productName} Web GUI`,
  title: `const productTitle = "${productName}";`,
  html: `<title>${productName}</title>`,
  standard: persona,
  ptc: persona,
  cordis: persona,
})

test('brands a freshly installed dependency tree', () => {
  const { stage, bootPath } = makeStage(pristine())
  try {
    brandInstalledRuntimePrompts({ stage, productName })
    assert.match(readFileSync(bootPath, 'utf8'), new RegExp(bootBranded))
    const preset = readFileSync(resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml'), 'utf8')
    assert.equal(preset, persona)
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
  const { stage, bootPath } = makeStage(branded())
  try {
    const before = statSync(bootPath).mtimeMs
    brandInstalledRuntimePrompts({ stage, productName })
    assert.equal(statSync(bootPath).mtimeMs, before, '已品牌化的文件不该被重写')
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('upstream drift still fails loudly', () => {
  const files = branded()
  files.boot = 'x The Something Else implementation checkout is at y'
  const { stage } = makeStage(files)
  try {
    assert.throws(() => brandInstalledRuntimePrompts({ stage, productName }), /品牌锚点/)
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('an extra upstream occurrence still fails loudly', () => {
  const files = pristine()
  files.boot = `${bootAnchor} a; ${bootAnchor} b`
  const { stage } = makeStage(files)
  try {
    assert.throws(() => brandInstalledRuntimePrompts({ stage, productName }), /出现 2 次,预期 1 次/)
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('client title branding escapes JavaScript and HTML and detects upstream drift', () => {
  const { stage } = makeStage(pristine())
  const modules = resolve(stage, 'dsh-plugin-desktop/node_modules/@deepseek-ai')
  const titlePath = resolve(modules, 'dsh-client-ui-layout/lib/client.js')
  try {
    const name = 'Cowork "R&D" <test>'
    brandInstalledRuntimePrompts({ stage, productName: name })
    assert.equal(new Function(readFileSync(titlePath, 'utf8') + 'return productTitle')(), name)
    assert.equal(readFileSync(resolve(modules, 'dsh-web-frontend/dist/index.html'), 'utf8'), '<title>Cowork "R&amp;D" &lt;test&gt;</title>')
    brandInstalledRuntimePrompts({ stage, productName: name })
    writeFileSync(titlePath, 'const productTitle = newBrandApi();')
    assert.throws(() => brandInstalledRuntimePrompts({ stage, productName: name }), /品牌锚点/)
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
