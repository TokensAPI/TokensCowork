// Desktop 启动时的市场策略：提供方固定为社区市场，官方「自定义插件市场」固定关闭。
// 两条都只在正常启动生效，Safe Mode 诊断会话不改 Profile。
import { insertAfter, insertBefore, replaceOnce, requireOnce } from '../../pipeline/anchors.mjs'

/**
 * 产品固定市场提供方为社区市场,并在每次正常启动时纠正持久记录。
 *
 * 上游把提供方选择交给首次设置向导,产品跳过了向导(见
 * skipDesktopSetupWizard);更关键的是崩溃恢复路径会把 disabled 以
 * legacyDefaulted: false 写盘,与用户显式关闭在数据上无法区分——被误关
 * 的用户没有任何提示,市场入口永久消失(v0.4.x 真机事故)。产品要求新老
 * 用户市场始终可用,因此正常启动时凡持久记录不是 community-market 一律
 * 纠正回来(机器状态与 Profile 偏好两处),Safe Mode 诊断会话不受影响。
 * 副作用:设置里切走市场只对当次运行生效,下次启动即复原——这正是
 * "默认永久开启"的产品语义。
 * @param mainSource - staging 副本中 main.ts 的完整内容。
 * @returns 启动时固定市场提供方后的源码。
 * @throws 上游市场选择锚点变化时抛出,中断打包待人工复查。
 */
export function pinDesktopMarketProvider(mainSource) {
  const anchor = `    const legacyMarketSelection = readDesktopMarketStateForUserData(marketUserDataDir)
    let profilePreferences = readDesktopProfilePreferences(marketUserDataDir, activeProfileDir)
    let marketSelection = profilePreferences === undefined`
  if (mainSource.split(anchor).length !== 2 || !/^\s+desktopProfilePreferencesFromSettings,$/mu.test(mainSource)) {
    throw new Error('prepare-desktop: 未找到市场选择读取锚点，请复查产品市场固定覆盖')
  }
  return mainSource.replace(
    anchor,
    `    let legacyMarketSelection = readDesktopMarketStateForUserData(marketUserDataDir)
    let profilePreferences = readDesktopProfilePreferences(marketUserDataDir, activeProfileDir)
    // 产品覆盖:市场提供方固定为社区市场。崩溃恢复会把 disabled 当显式
    // 选择写盘,被误关的用户没有恢复路径;正常启动时一律纠正两处持久
    // 记录,Safe Mode 诊断会话除外。
    if (safeModePaths === undefined) {
      if (legacyMarketSelection.requested !== 'community-market') {
        legacyMarketSelection = await selectDesktopMarketProvider(marketUserDataDir, 'community-market')
      }
      if (profilePreferences !== undefined && profilePreferences.market !== 'community-market') {
        // 读回的是带 version/profileHash/recordedAt 的存储记录；写入只接受六个偏好字段。
        profilePreferences = await writeDesktopProfilePreferences(marketUserDataDir, activeProfileDir,
          desktopProfilePreferencesFromSettings(profilePreferences, profilePreferences.notifications,
            'community-market', profilePreferences.aaEnabled === true))
      }
    }
    let marketSelection = profilePreferences === undefined`,
  )
}

const PROFILE_MARKER = '/* TokensCowork: 产品不提供官方「自定义插件市场」。 */'

/** 产品覆盖在 profile.ts 里补上的关闭入口；上游只有「开/关」一个写入函数，没有清理预置源的那一半。 */
const disableOfficialMarket = `${PROFILE_MARKER}
/**
 * 产品覆盖：关掉官方「自定义插件市场」bundle，并清掉它预置的索引源。
 *
 * 上游 configureDesktopOfficialPluginMarket(dir, false) 只从 bundles 里摘掉包，
 * 开启时写进 cordis.patch.yml 的 dsh-market 索引源留在原地；bundle 关掉之后那一行
 * 指向不再加载的 plugin-market，是纯残留，所以一并清掉。只清我们认得的那一条
 * 预置 URL：用户自己加过的索引保留，行里除 id/config 以外还有别的键也保留。
 * @param profileDir - 活动 Profile 目录。
 * @returns 是否改动过 Profile（没有改动不写盘）。
 */
export function disableDesktopOfficialPluginMarket(profileDir: string): boolean {
  const enabled = readDesktopOfficialPluginMarketEnabled(profileDir)
  if (enabled) configureDesktopOfficialPluginMarket(profileDir, false)
  return clearDesktopOfficialPluginMarketDefaultSource(join(profileDir, PROFILE_PATCH_FILENAME)) || enabled
}

/** 产品覆盖：从 cordis.patch.yml 去掉官方自定义市场预置的索引源，没有可清的就不写盘。 */
function clearDesktopOfficialPluginMarketDefaultSource(patchPath: string): boolean {
  if (lstatSync(patchPath, { throwIfNoEntry: false })?.isSymbolicLink()) return false
  let before: string
  try {
    before = readFileSync(patchPath, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    return false
  }
  const patchDocument = parseDocument(before, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  if (patchDocument.errors.length > 0 || !isSeq(patchDocument.contents)) return false
  const rows = patchDocument.contents
  let changed = false
  for (let index = rows.items.length - 1; index >= 0; index -= 1) {
    const item = rows.items[index]
    if (!isMap(item)) continue
    if (patchDocument.getIn([index, 'id']) !== OFFICIAL_PLUGIN_MARKET_ROW_ID) continue
    if (item.has('insert')) continue
    if (item.has('name') && patchDocument.getIn([index, 'name']) !== OFFICIAL_PLUGIN_MARKET_PACKAGE) continue
    const config = patchDocument.getIn([index, 'config'], true)
    if (!isMap(config)) continue
    const rawIndexes = config.toJS(patchDocument) as { indexes?: unknown }
    const existing = Array.isArray(rawIndexes.indexes)
      ? rawIndexes.indexes.filter((entry): entry is string => typeof entry === 'string')
      : []
    const kept = existing.filter(entry => entry !== DEFAULT_OFFICIAL_MARKET_INDEX_URL)
    if (kept.length === existing.length) continue
    if (kept.length > 0) config.set('indexes', patchDocument.createNode(kept))
    else config.delete('indexes')
    changed = true
    // 预置的那一条清掉之后整行空了，就是纯残留；还带着别的键的行留给用户。
    if (config.items.length > 0) continue
    const rowKeys = Object.keys(item.toJS(patchDocument) as Record<string, unknown>)
    if (!rowKeys.every(key => key === 'id' || key === 'config')) continue
    patchDocument.deleteIn([index])
  }
  if (!changed) return false
  rows.flow = false
  replaceDocument(patchPath, String(patchDocument))
  return true
}

`

/**
 * 官方「自定义插件市场」bundle 在正常启动时固定关闭。
 *
 * market.plugin-page-hide-official-market 只是把它从插件页的「更多」清单里藏掉，
 * 在 0.7.0 上点开过它的 Profile（bundles 里留着这个包）因此卡在上游那个要用户
 * 自己「添加索引源」的「发现」空壳上，界面上再没有任何地方能关掉它。产品只有一个
 * 固定市场，所以正常启动一律关掉并清掉它预置的索引源，与 market.desktop-provider
 * 同一处、同一口径；Safe Mode 诊断会话不改 Profile。
 *
 * 关闭写在 prepareDesktopProfile 之前：Profile 装配会按 bundles 组合入口，晚一步
 * 这一次启动仍会加载官方市场。上游的设置向导是唯一会再打开它的调用方，而产品跳过
 * 向导（skipDesktopSetupWizard），所以关掉之后不会再被打开。
 * @param mainSource - staging 副本中 main.ts 的完整内容。
 * @param profileSource - staging 副本中 profile.ts 的完整内容。
 * @returns 改写后的两个文件内容。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function pinDesktopOfficialPluginMarketOff(mainSource, profileSource) {
  let profile = profileSource
  if (profile.includes(PROFILE_MARKER)) {
    requireOnce(profile, 'export function disableDesktopOfficialPluginMarket(', '官方市场关闭入口')
  } else {
    profile = insertBefore(profile, 'interface ParsedProfileYaml {', disableOfficialMarket, '官方市场关闭入口')
  }
  if (mainSource.includes('disableDesktopOfficialPluginMarket(activeProfileDir)')) {
    requireOnce(mainSource, '  disableDesktopOfficialPluginMarket,\n', '官方市场关闭入口导入')
    return { main: mainSource, profile }
  }
  const imported = replaceOnce(mainSource,
    `  desktopInstallAnchor,
  healDesktopProfileModuleFallback,`,
    `  desktopInstallAnchor,
  disableDesktopOfficialPluginMarket,
  healDesktopProfileModuleFallback,`,
    '官方市场关闭入口导入')
  return {
    main: insertAfter(imported, '    const lanAddresses = desktopLanAddresses()', `
    // 产品覆盖：官方「自定义插件市场」不属于产品（插件页的清单里已经藏掉它），
    // 但 0.7.0 上点开过的 Profile 还留着这个 bundle，界面上已经没有地方关掉。
    // 正常启动一律关掉并清掉它预置的索引源，Safe Mode 诊断会话不改 Profile。
    if (safeModePaths === undefined) disableDesktopOfficialPluginMarket(activeProfileDir)`,
      '官方市场启动关闭'),
    profile,
  }
}

/** 产品回归：关闭官方市场连同清掉它预置的索引源，在 staging 的 Desktop Vitest 里跑真实 yaml。 */
const offTest = `
  // 产品回归：上游只有「开/关」，关掉之后预置的索引源留在原地；产品这一半要清干净。
  it('product: disabling the official Custom Plugin Market also clears its preconfigured index source', () => {
    const home = temporaryHome()
    const profileDir = ensureDesktopProfile(home)
    configureDesktopOfficialPluginMarket(profileDir, true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain(DEFAULT_OFFICIAL_MARKET_INDEX_URL)

    expect(disableDesktopOfficialPluginMarket(profileDir)).toBe(true)
    expect(readDesktopOfficialPluginMarketEnabled(profileDir)).toBe(false)
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain(DEFAULT_OFFICIAL_MARKET_INDEX_URL)
    expect(patch).not.toContain('id: plugin-market')
    // 已经关掉的 Profile 不再写盘。
    expect(disableDesktopOfficialPluginMarket(profileDir)).toBe(false)
  })

  it('product: clearing the preconfigured index source keeps the indexes a user added', () => {
    const home = temporaryHome()
    const profileDir = ensureDesktopProfile(home)
    configureDesktopOfficialPluginMarket(profileDir, true)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, [
      '- id: plugin-market',
      '  config:',
      '    indexes:',
      \`      - \${DEFAULT_OFFICIAL_MARKET_INDEX_URL}\`,
      '      - https://example.invalid/dsh-index.json',
      '',
    ].join('\\n'))

    expect(disableDesktopOfficialPluginMarket(profileDir)).toBe(true)
    const patch = readFileSync(patchPath, 'utf8')
    expect(patch).not.toContain(DEFAULT_OFFICIAL_MARKET_INDEX_URL)
    expect(patch).toContain('https://example.invalid/dsh-index.json')
    expect(patch).toContain('id: plugin-market')
  })
`

/**
 * 上游 Profile 用例补上产品回归：关闭官方市场同时清掉预置索引源，用户自己加的索引保留。
 *
 * 这一步的价值在于用真实 `yaml` 跑覆盖写进 profile.ts 的清理逻辑——构建模块自己的
 * 回归没有 yaml 依赖，只能校验锚点落点。staging 的 `yarn run check` 会执行这份用例。
 * @param source - staging 副本中 tests/profile.spec.ts 的完整内容。
 * @returns 追加产品回归后的用例源码。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function addOfficialPluginMarketOffTest(source) {
  if (source.includes('disableDesktopOfficialPluginMarket')) {
    requireOnce(source, 'also clears its preconfigured index source', '官方市场关闭用例')
    return source
  }
  const imported = replaceOnce(source,
    `  desktopBundleList,
  ensureDesktopProfile,`,
    `  desktopBundleList,
  disableDesktopOfficialPluginMarket,
  ensureDesktopProfile,`,
    '官方市场关闭用例导入')
  return replaceOnce(imported,
    `    configureDesktopOfficialPluginMarket(profileDir, false)
    expect(readDesktopOfficialPluginMarketEnabled(profileDir)).toBe(false)
  })
})`,
    `    configureDesktopOfficialPluginMarket(profileDir, false)
    expect(readDesktopOfficialPluginMarketEnabled(profileDir)).toBe(false)
  })
${offTest}})`,
    '官方市场关闭用例')
}
