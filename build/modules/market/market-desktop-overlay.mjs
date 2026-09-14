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
  if (mainSource.split(anchor).length !== 2) {
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
        profilePreferences = await writeDesktopProfilePreferences(marketUserDataDir, activeProfileDir, {
          ...profilePreferences,
          market: 'community-market',
        })
      }
    }
    let marketSelection = profilePreferences === undefined`,
  )
}
