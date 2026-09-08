import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { brandInstalledRuntimePrompts } from './branding-overlay.mjs'

const productName = 'TokensCowork'
const bootAnchor = 'The DeepSeek Harness implementation checkout is at'
const bootBranded = `The ${productName} implementation checkout is at`
const guiAnchor = 'DeepSeek Harness Web GUI'
const codingStandard = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
const codingCordis = 'You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.'
const persona = `You are a versatile AI assistant inside ${productName}, powered by the {{model}} model. You handle coding, research, writing, and everyday tasks alike. Your working directory is {{cwd}}.`

// 造一份最小的"已装好的依赖树",只含被品牌化的那几个文件。
function makeStage(files) {
  const stage = mkdtempSync(resolve(tmpdir(), 'branding-overlay-'))
  const modules = resolve(stage, 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai')
  const write = (path, text) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text) }
  write(resolve(modules, 'dsh-app-boot', 'lib', 'index.js'), files.boot)
  write(resolve(modules, 'dsh-web-app', 'lib', 'index.js'), files.gui)
  for (const preset of ['standard', 'ptc', 'cordis']) {
    write(resolve(modules, 'dsh-agent-presets', 'presets', preset, 'agent.cordis.yml'), files[preset])
  }
  return { stage, bootPath: resolve(modules, 'dsh-app-boot', 'lib', 'index.js') }
}

const pristine = () => ({
  boot: `x ${bootAnchor} y`,
  gui: `${guiAnchor} ... ${guiAnchor}`,
  standard: codingStandard,
  ptc: codingStandard,
  cordis: codingCordis,
})

const branded = () => ({
  boot: `x ${bootBranded} y`,
  gui: `${productName} Web GUI ... ${productName} Web GUI`,
  standard: persona,
  ptc: persona,
  cordis: persona,
})

test('brands a freshly installed dependency tree', () => {
  const { stage, bootPath } = makeStage(pristine())
  try {
    brandInstalledRuntimePrompts({ stage, productName })
    assert.match(readFileSync(bootPath, 'utf8'), new RegExp(bootBranded))
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

// node_modules 跨装配保留(见 steps/staging-prepare.mjs),所以本函数一定会再次
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
