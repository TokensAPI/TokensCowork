import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve, relative } from 'node:path'
import { loadOverlays, runOverlays } from '../../pipeline/overlay-engine.mjs'

const root = resolve(import.meta.dirname, '../../..')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const marketOverlays = (await loadOverlays()).filter(overlay => overlay.module === 'market' && overlay.phase === 'prepare')

function fixture(t) {
  const generated = resolve(root, '.build')
  mkdirSync(generated, { recursive: true })
  const stage = mkdtempSync(resolve(generated, 'desktop-market-entry-'))
  t.after(() => {
    assert.ok(relative(generated, stage).startsWith('desktop-market-entry-'))
    rmSync(stage, { recursive: true, force: true })
  })
  cpSync(resolve(root, 'desktop/dsh-community-market'), resolve(stage, 'dsh-community-market'), {
    recursive: true,
    filter: path => !['.git', 'node_modules', 'lib'].includes(basename(path)),
  })
  mkdirSync(resolve(stage, 'dsh-plugin-desktop/src/client'), { recursive: true })
  mkdirSync(resolve(stage, 'dsh-plugin-desktop/tests'), { recursive: true })
  for (const file of ['src/main.ts', 'src/client/plugin-controls.tsx', 'src/client/desktop-settings.ts',
    'tests/client-desktop-settings.spec.ts']) {
    cpSync(resolve(root, `desktop/dsh-plugin-desktop/${file}`), resolve(stage, `dsh-plugin-desktop/${file}`))
  }
  return stage
}

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory()
      ? Object.entries(snapshot(path)).map(([child, bytes]) => [`${entry.name}/${child}`, bytes])
      : [[entry.name, readFileSync(path)]]
  }))
}

const assemble = stage => runOverlays('prepare', { stage, product, overlays: marketOverlays })

test('registered market overlays assemble product behaviors and leave unchanged API tests intact', async t => {
  const stage = fixture(t)
  const market = resolve(stage, 'dsh-community-market')
  const read = path => readFileSync(resolve(market, path), 'utf8')
  const apiTests = read('tests/client-api.spec.ts')
  const results = await assemble(stage)
  assert.ok(results.every(result => result.status === 'changed'), JSON.stringify(results.filter(result => result.status !== 'changed')))
  assert.match(read('src/client/MarketSettingsTab.tsx'), /initialView = 'discover'/)
  assert.match(read('src/install/service.ts'), /async executeUpdate/)
  assert.match(read('src/install/service.ts'), /registry\/by-package/)
  assert.match(read('src/host/routes.ts'), /service.invalidateSource/)
  assert.doesNotMatch(read('src/client/locales.ts'), /DeepSeek Harness/)
  // 慢网络文案在最后的品牌替换之后仍然在位。
  assert.match(read('src/client/locales.ts'), /operationTimeout: "下载安装包超时/)
  assert.equal(read('tests/client-api.spec.ts'), apiTests)
  for (const template of ['market-update.spec.ts', 'market-registry-candidates.spec.ts']) {
    assert.equal(read(`tests/${template}`), readFileSync(resolve(import.meta.dirname, template), 'utf8'))
  }
  assert.match(readFileSync(resolve(stage, 'dsh-plugin-desktop/src/main.ts'), 'utf8'), /市场提供方固定为社区市场/)
  const controls = readFileSync(resolve(stage, 'dsh-plugin-desktop/src/client/plugin-controls.tsx'), 'utf8')
  assert.match(controls, /title: 'TokensCowork 插件市场'/)
  assert.doesNotMatch(controls, /MarketSourcesButton|MARKET_OPTIONS|dshNextPluginSections/)
  assert.match(readFileSync(resolve(stage, 'dsh-plugin-desktop/src/client/desktop-settings.ts'), 'utf8'),
    /\[COMMUNITY_MARKET, DSH_MARKET, REMOTE_CONTROL_BUNDLE, OFFICIAL_MARKET\]/)
  assert.match(readFileSync(resolve(stage, 'dsh-plugin-desktop/tests/client-desktop-settings.spec.ts'), 'utf8'),
    /toHaveBeenNthCalledWith\(6, \{/)
  const assembled = snapshot(market)
  await assert.rejects(assemble(stage), /^Error: \[market\.synthetic-proxy\] dsh-community-market\/src\/network\/restricted-http\.ts:/)
  assert.deepEqual(snapshot(market), assembled)
})

test('a late upstream anchor failure names the overlay and leaves all market files unchanged', async t => {
  const stage = fixture(t)
  const market = resolve(stage, 'dsh-community-market')
  writeFileSync(resolve(market, 'src/client/styles.ts'), '// upstream changed its style anchor\n')
  const before = snapshot(market)
  await assert.rejects(assemble(stage), /\[market\.discover-home-styles\] dsh-community-market\/src\/client\/styles\.ts: market-home: upstream anchor changed/)
  assert.deepEqual(snapshot(market), before)
})
