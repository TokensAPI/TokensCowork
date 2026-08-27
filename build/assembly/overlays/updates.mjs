/* ============================================================
 * 产品覆盖：自动更新
 * ============================================================
 * 停用指向官方 DSH Desktop 的上游更新服务，并将启动验收切换到
 * 产品更新策略（有替代插件时验收产品菜单，无时验收全部隐藏）。
 * 每个导出函数自带锚点守护：上游代码变动导致锚点失配时装配立即
 * 失败，等待人工复查，绝不静默漏掉覆盖。
 * ============================================================ */

/**
 * 追加停用上游 desktop-updates 插件的覆盖条目，阻止官方 DSH Desktop 更新推送覆盖本产品。
 * @param patch - staging 副本中 cordis.patch.yml 的完整内容。
 * @returns 追加停用覆盖条目后的补丁内容。
 * @throws 上游 desktop-updates 注册条目与锚点不一致时抛出，中断打包待人工复查。
 */
export function disableUpstreamUpdates(patch) {
  const upstreamEntry = '    - id: desktop-updates\n      name: dsh-plugin-desktop/updates'
  if (!patch.includes(upstreamEntry)) {
    throw new Error('prepare-desktop: 未找到上游 desktop-updates 注册条目，请复查更新覆盖配置')
  }
  return `${patch}\n\n# 产品覆盖：上游更新服务指向官方 DSH Desktop，与本产品无关，予以停用。\n`
    + '- id: desktop-updates\n  disabled: true'
}

/**
 * 将上游启动验收改为产品更新菜单验收：旧菜单必须消失，新菜单必须存在。
 * 产品停用 desktop-updates 后，原校验会把产品插件提供的菜单误判为上游菜单。
 * @param script - staging 副本中 verify-profile-boot.mjs 的完整内容。
 * @returns 与产品更新策略一致的启动验收脚本。
 * @throws 上游校验锚点变化时抛出，中断打包待人工复查。
 */
export function verifyProductUpdateMenu(script) {
  const upstreamCheck = `  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }`
  if (!script.includes(upstreamCheck)) {
    throw new Error('prepare-desktop: 未找到上游更新菜单验收锚点，请复查产品更新策略')
  }
  return script.replace(
    upstreamCheck,
    `  if (trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled product profile unexpectedly retains the upstream update tray command')
  }
  if (!trayItems.some(item => item.label() === 'Check Updates…')) {
    throw new Error('assembled product profile is missing the product update tray command')
  }`,
  )
}

/**
 * 将上游启动验收改为无更新菜单验收：官方更新已停用，且产品没有内置替代插件。
 * @param script - staging 副本中 verify-profile-boot.mjs 的完整内容。
 * @returns 与纯净产品更新策略一致的启动验收脚本。
 * @throws 上游校验锚点变化时抛出，中断打包待人工复查。
 */
export function verifyDisabledUpdateMenu(script) {
  const upstreamCheck = `  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }`
  if (!script.includes(upstreamCheck)) {
    throw new Error('prepare-desktop: 未找到上游更新菜单验收锚点，请复查产品更新策略')
  }
  return script.replace(
    upstreamCheck,
    `  if (trayItems.some(item => item.label() === 'Check for Updates…'
    || item.label() === 'Check Updates…')) {
    throw new Error('assembled clean product profile unexpectedly retains an update tray command')
  }`,
  )
}

/**
 * 让产品更新插件跟随当前品牌和发布仓库，而不修改只读插件子模块。
 * 在 staging 的 Desktop 补丁中为 tokens-version-updates 追加产品配置。
 * @param desktopPatch - staging 副本 cordis.patch.yml 的完整内容。
 * @param product - product.json 的 product 段。
 * @param owner - 发布仓库 owner。
 * @param repo - 发布仓库名。
 * @returns 追加配置后的补丁内容。
 * @throws 更新插件注册条目缺失时抛出，中断打包待人工复查。
 */
export function configureProductUpdates(desktopPatch, product, owner, repo) {
  const productUpdateEntry = `    - id: tokens-version-updates
      name: '@tokens/dsh-version-updates'`
  if (!desktopPatch.includes(productUpdateEntry)) {
    throw new Error('configure-product: cannot locate TokensCowork update plugin entry')
  }
  const configuredEntry = `${productUpdateEntry}
      config:
        productName: ${product.name}
        githubOwner: ${owner}
        githubRepo: ${repo}
        releaseIndexURL: https://${owner.toLowerCase()}.github.io/${repo}/releases.json
        releaseAPIURL: https://api.github.com/repos/${owner}/${repo}/releases/latest`
  return desktopPatch.replace(productUpdateEntry, configuredEntry)
}
