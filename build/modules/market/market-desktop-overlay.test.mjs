import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import {
  addOfficialPluginMarketOffTest, pinDesktopMarketProvider, pinDesktopOfficialPluginMarketOff,
} from './market-desktop-overlay.mjs'

const read = file => readFileSync(new URL(`../../../desktop/dsh-plugin-desktop/src/${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const preferencesSource = read('profile-preferences.ts')
// Upstream's write accepts exactly these selection keys; the stored record adds version/profileHash/recordedAt.
const selectionKeys = JSON.parse(`[${/const SELECTION_KEYS = Object\.freeze\(\[([^\]]+)\]/u.exec(preferencesSource)[1].replaceAll("'", '"').trim().replace(/,$/u, '')}]`)
const start = preferencesSource.indexOf('export function desktopProfilePreferencesFromSettings(')
const fromSettings = new Function(`${stripTypeScriptTypes(preferencesSource.slice(start, preferencesSource.indexOf('\n}\n', start) + 3)).replace('export ', '')}
return desktopProfilePreferencesFromSettings`)()

const patched = pinDesktopMarketProvider(read('main.ts'))
const block = patched.slice(patched.indexOf('    if (safeModePaths === undefined) {\n      if (legacyMarketSelection'),
  patched.indexOf('    let marketSelection = profilePreferences === undefined'))

async function startWith(stored, safeModePaths) {
  const writes = []
  const run = new Function('safeModePaths', 'legacyMarketSelection', 'profilePreferences', 'selectDesktopMarketProvider',
    'writeDesktopProfilePreferences', 'desktopProfilePreferencesFromSettings', 'marketUserDataDir', 'activeProfileDir',
    `return (async () => { ${stripTypeScriptTypes(block)}; return profilePreferences })()`)
  const result = await run(safeModePaths, { requested: 'community-market' }, stored, async () => ({ requested: 'community-market' }),
    async (_userData, _profile, value) => {
      assert.deepEqual(Object.keys(value).sort(), [...selectionKeys].sort(), 'write must carry exactly the supported fields')
      writes.push(value)
      return { version: 1, profileHash: 'h', ...value, recordedAt: 'now' }
    }, fromSettings, '/user', '/profile')
  return { result, writes }
}

const stored = Object.freeze({
  version: 1, profileHash: 'a'.repeat(64), mode: 'extended', openBrowser: false, networkExposure: 'local',
  notifications: { enabled: true }, aaEnabled: true, market: 'dsh-market', recordedAt: '2026-10-12T00:00:00.000Z',
})

test('a user-switched market is pinned back with exactly the preference fields upstream accepts', async () => {
  const { result, writes } = await startWith(stored, undefined)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], { mode: 'extended', openBrowser: false, networkExposure: 'local',
    notifications: { enabled: true }, market: 'community-market', aaEnabled: true })
  assert.equal(result.market, 'community-market')
})

test('Safe Mode and an already pinned market write nothing', async () => {
  assert.equal((await startWith(stored, {})).writes.length, 0)
  assert.equal((await startWith({ ...stored, market: 'community-market' }, undefined)).writes.length, 0)
})

const upstreamProfile = read('profile.ts')
const off = pinDesktopOfficialPluginMarketOff(read('main.ts'), upstreamProfile)

test('the official market is closed in the normal-startup branch before the Profile is composed', () => {
  const call = off.main.indexOf('if (safeModePaths === undefined) disableDesktopOfficialPluginMarket(activeProfileDir)')
  assert.ok(call > off.main.indexOf('const activeProfileDir = resolveProfileDir('), 'the Profile directory must already be resolved')
  // 晚于 Profile 装配就白跑一次：装配按 bundles 组合入口，这次启动仍会加载官方市场。
  assert.ok(call < off.main.indexOf('let prepared = prepareDesktopProfile('), 'the bundle must be removed before composition')
  assert.equal(off.main.split('disableDesktopOfficialPluginMarket').length - 1, 2, 'one import and one call')
})

test('the closing helper only uses identifiers upstream profile.ts already provides', () => {
  const added = off.profile.slice(off.profile.indexOf('/* TokensCowork:'), off.profile.indexOf('interface ParsedProfileYaml {'))
  assert.match(added, /export function disableDesktopOfficialPluginMarket\(/)
  for (const identifier of ['readDesktopOfficialPluginMarketEnabled', 'configureDesktopOfficialPluginMarket',
    'OFFICIAL_PLUGIN_MARKET_ROW_ID', 'OFFICIAL_PLUGIN_MARKET_PACKAGE', 'DEFAULT_OFFICIAL_MARKET_INDEX_URL',
    'PROFILE_PATCH_FILENAME', 'replaceDocument', 'lstatSync', 'readFileSync', 'parseDocument', 'isSeq', 'isMap', 'join']) {
    assert.ok(added.includes(identifier), `the added helper should use ${identifier}`)
    assert.ok(upstreamProfile.includes(identifier), `upstream profile.ts no longer provides ${identifier}`)
  }
})

test('re-applying the official market closure changes nothing and keeps the Profile regression once', () => {
  const again = pinDesktopOfficialPluginMarketOff(off.main, off.profile)
  assert.equal(again.main, off.main)
  assert.equal(again.profile, off.profile)
  const spec = addOfficialPluginMarketOffTest(read('../tests/profile.spec.ts'))
  assert.equal(addOfficialPluginMarketOffTest(spec), spec)
  // 追加在 describe 内部：文件最后一行仍是它的收尾。
  assert.ok(spec.trimEnd().endsWith('})'))
  assert.equal(spec.split("it('product: ").length - 1, 2)
  assert.ok(spec.indexOf("it('product: ") > spec.indexOf('describe('))
  assert.match(spec, /^ {2}disableDesktopOfficialPluginMarket,$/mu)
})
