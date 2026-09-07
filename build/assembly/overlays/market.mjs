/* ============================================================
 * 产品覆盖：插件市场
 * ============================================================
 * 将市场收敛为产品自营目录源：fake-IP 代理豁免、预置 TokensAPI
 * 源并默认选中、清空上游合作源、隐藏手动添加与删除入口、精简
 * 固定来源页面的说明信息，并统一 Market 品牌文案。
 * 每个导出函数自带锚点守护：上游代码变动导致锚点失配时装配立即
 * 失败，等待人工复查，绝不静默漏掉覆盖。
 * ============================================================ */

import { randomUUID } from 'node:crypto'

/**
 * 为插件市场的受限 HTTP 客户端加入产品插件源主机名的 fake-IP 豁免。
 * 上游只给自家合作源豁免了 fake-IP 代理网段（198.18.0.0/15），国内用户
 * 常开的 fake-IP 代理会把产品源域名也解析进该保留网段，导致添加源被
 * blocked-address 拒绝。同时上游豁免只认 IPv4：代理同时返回 IPv6 假地址
 * （fc00::/7）时仍会失败，故豁免主机名改为仅保留能通过校验的地址。
 * @param source - staging 副本中 restricted-http.ts 的完整内容。
 * @param hostname - 产品插件源主机名（来自 market/source.config.json）。
 * @returns 加入豁免后的模块内容。
 * @throws 主机名非法或上游锚点变化时抛出，中断打包待人工复查。
 */
export function allowMarketSourceSyntheticProxy(source, hostname) {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname)) {
    throw new Error(`prepare-desktop: 市场插件源主机名不合法: ${hostname}`)
  }
  const clientAnchor = 'export const restrictedHttpClient: CatalogHttpClient = createRestrictedHttpClient()'
  const lookupAnchor = `  const allowSyntheticProxyAddress = syntheticProxyHostnames.has(hostname.toLowerCase())
  for (const entry of addresses) {
    if (entry.family !== assertSafeAddress(entry.address, allowSyntheticProxyAddress)) {
      throw new CatalogNetworkError('blocked-address')
    }
  }
  const first = addresses[0]!
  return { address: first.address, family: assertSafeAddress(first.address, allowSyntheticProxyAddress) }`
  if (!source.includes(clientAnchor) || !source.includes(lookupAnchor)) {
    throw new Error('prepare-desktop: 未找到市场受限 HTTP 客户端锚点，请复查 fake-IP 豁免覆盖')
  }
  const patchedClient = 'export const restrictedHttpClient: CatalogHttpClient = createRestrictedHttpClient({\n'
    + '  // 产品覆盖：产品插件源在 fake-IP 代理下解析进保留网段，加入豁免。\n'
    + `  syntheticProxyHostnames: ['${hostname}'],\n`
    + '})'
  const patchedLookup = `  const allowSyntheticProxyAddress = syntheticProxyHostnames.has(hostname.toLowerCase())
  // 产品覆盖：fake-IP 代理可能同时返回 IPv4 与 IPv6 假地址，而豁免网段只有
  // IPv4（198.18.0.0/15）。豁免主机名仅保留能通过校验的地址；非豁免主机名
  // 保持任一地址越界即拒绝的上游原语义。
  const usable = []
  for (const entry of addresses) {
    if (!allowSyntheticProxyAddress) {
      if (entry.family !== assertSafeAddress(entry.address, false)) {
        throw new CatalogNetworkError('blocked-address')
      }
      usable.push(entry)
      continue
    }
    try {
      if (entry.family === assertSafeAddress(entry.address, true)) usable.push(entry)
    } catch {}
  }
  const first = usable[0]
  if (first === undefined) throw new CatalogNetworkError('blocked-address')
  return { address: first.address, family: first.family }`
  return source.replace(clientAnchor, patchedClient).replace(lookupAnchor, patchedLookup)
}

/**
 * 将插件市场收敛为产品自营源：预置 TokensAPI 目录源并默认选中、清空上游
 * 合作源目录、隐藏来源的添加/删除入口和冗余说明。用户打开市场即浏览
 * 产品源，无需手动登记；Host 同时拒绝删除产品源，避免绕过界面误删。
 * 上游标准源机制本身保持不变（校验、缓存、快照均走原逻辑）。
 * @param sources - staging 副本中市场各文件的内容。
 * @param origin - 产品目录源 origin（来自 market/source.config.json）。
 * @param manifest - 产品目录源 manifest 的完整 JSON 对象（market/source.json）。
 * @returns 改写后的各文件内容。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function pinProductMarketSource(sources, origin, manifest) {
  const { index, routes, sourceStore, service, settingsTab, locales } = sources
  // 1) Host:设置 schema 的 sources 默认值从 [] 换成预置的产品源记录；
  //    产品入口同时在注册路由前迁移旧配置并补回缺失的产品源。
  //    记录形状须过 validateLocalSourceRecords:user-added + manifestUrl +
  //    注册时 manifest 快照 + UUID。UUID 在装配时固定生成,同一版本安装包
  //    内一致;用户侧首次读取即落库,与手动添加的记录无区别。
  const schemaAnchor = 'const SETTINGS_SCHEMA = z.object({'
  const defaultsAnchor = '  sources: z.array(SOURCE_SCHEMA).default([]),'
  if (!routes.includes(schemaAnchor) || !routes.includes(defaultsAnchor)) {
    throw new Error('prepare-desktop: 未找到市场源默认值锚点，请复查产品源预置覆盖')
  }
  const seededRecord = {
    sourceRecordId: randomUUID(),
    registrationKind: 'user-added',
    adapterId: 'market.standard-http-v1',
    providerId: manifest.providerId,
    manifestUrl: `${origin}/source.json`,
    manifest,
    enabled: true,
    order: 0,
  }
  let patchedRoutes = routes
    .replace(
      schemaAnchor,
      `export const PRODUCT_SOURCE = ${JSON.stringify(seededRecord)} as never\n${schemaAnchor}`,
    )
    .replace(
      defaultsAnchor,
      '  // 产品覆盖：预置 TokensAPI 官方目录源并默认选中。\n'
      + '  sources: z.array(SOURCE_SCHEMA).default([PRODUCT_SOURCE] as never),',
    )
  // 预置源虽然复用标准 user-added 记录形状，但它是产品运行所需的固定入口。
  // Renderer 隐藏删除按钮之外，Host 也拒绝删除，避免直接调用 API 或旧客户端
  // 把唯一来源清空后留下不可恢复的空市场。
  const removeSourceAnchor = `    if (mutation.action === 'remove') {
      unavailableSourceRecordIds.add(records[index]!.sourceRecordId)`
  if (!patchedRoutes.includes(removeSourceAnchor)) {
    throw new Error('prepare-desktop: 未找到市场删除来源锚点，请复查产品源保护覆盖')
  }
  patchedRoutes = patchedRoutes.replace(
    removeSourceAnchor,
    `    if (mutation.action === 'remove') {
      const target = records[index]!
      if (target.providerId === ${JSON.stringify(manifest.providerId)}
        && target.manifestUrl === ${JSON.stringify(`${origin}/source.json`)}) {
        throw new Error('product source cannot be removed')
      }
      unavailableSourceRecordIds.add(target.sourceRecordId)`,
  )
  // 2) Source store:提供一次性迁移函数。产品入口在注册 Web 路由前等待迁移
  //    完成，并将来源收敛为唯一产品源；通用 store/load 保持上游原语义。
  const sourceStoreClassAnchor = 'export class SettingsCatalogSourceStore implements CatalogSourceStore {'
  if (!sourceStore.includes(sourceStoreClassAnchor)) {
    throw new Error('prepare-desktop: 未找到市场来源存储锚点，请复查产品源自愈覆盖')
  }
  const requiredSourceRepair = `export async function ensureRequiredSource(
  scope: SettingsScope<MarketSettingsDocument>,
  requiredSource: LocalSourceRecord,
): Promise<void> {
  const records = [...scope.get().sources]
  validateLocalSourceRecords(records)
  const isRequired = (record: LocalSourceRecord): boolean => (
    record.providerId === requiredSource.providerId
    && record.manifestUrl === requiredSource.manifestUrl
  )
  const existing = records.find(isRequired)
  const required = {
    ...requiredSource,
    sourceRecordId: existing?.sourceRecordId ?? requiredSource.sourceRecordId,
    enabled: true,
    order: 0,
  }
  const repaired = [required]
  validateLocalSourceRecords(repaired)
  if (JSON.stringify(records) !== JSON.stringify(repaired)) {
    await scope.update({ sources: repaired })
  }
}

`
  const patchedSourceStore = sourceStore.replace(
    sourceStoreClassAnchor,
    `${requiredSourceRepair}${sourceStoreClassAnchor}`,
  )
  const indexRoutesImportAnchor = `import {
  registerMarketRoutes,
  registerMarketSettings,
  type MarketDesktopPlugins,
} from './host/routes.js'`
  const indexRouteEffectAnchor = `  ctx.effect(
    () => registerMarketRoutes(ctx, scope, installProvider, desktopActionsProvider, desktopPluginsProvider),
    'community-market: routes',
  )`
  if (!index.includes(indexRoutesImportAnchor) || !index.includes(indexRouteEffectAnchor)) {
    throw new Error('prepare-desktop: 未找到市场产品源启动迁移锚点，请复查产品源自愈覆盖')
  }
  const patchedIndex = index
    .replace(
      indexRoutesImportAnchor,
      `import { ensureRequiredSource } from './catalog/source-store.js'
import {
  PRODUCT_SOURCE,
  registerMarketRoutes,
  registerMarketSettings,
  type MarketDesktopPlugins,
} from './host/routes.js'`,
    )
    .replace(
      indexRouteEffectAnchor,
      `  ctx.effect(
    async () => {
      await ensureRequiredSource(scope, PRODUCT_SOURCE)
      return registerMarketRoutes(ctx, scope, installProvider, desktopActionsProvider, desktopPluginsProvider)
    },
    'community-market: repair product source and register routes',
  )`,
    )
  // 3) Host:清空内置合作源目录(1024Store/dshfind 不再出现在可添加列表)。
  const builtInAnchor = 'export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = ['
  if (!service.includes(builtInAnchor)) {
    throw new Error('prepare-desktop: 未找到市场内置源目录锚点，请复查产品源预置覆盖')
  }
  const builtInEnd = service.indexOf(']\n', service.indexOf(builtInAnchor))
  if (builtInEnd < 0) {
    throw new Error('prepare-desktop: 市场内置源目录结构异常，请复查产品源预置覆盖')
  }
  // void 引用保住合作源常量的 import：目录清空后 noUnusedLocals 会拒绝未再
  // 使用的导入，而适配器路由表等处仍引用同一导入的其他成员，逐个改易漏。
  const patchedService = `${service.slice(0, service.indexOf(builtInAnchor))}`
    + '// 产品覆盖：不提供上游合作源，市场只浏览产品自营目录源。\n'
    + 'void [DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_ENDPOINT, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID, dsh1024StoreAdapter, DSHFIND_ADAPTER_ID, DSHFIND_ENDPOINT, DSHFIND_KEY, DSHFIND_PROVIDER_ID, dshfindAdapter]\n'
    + 'export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = ['
    + service.slice(builtInEnd)
  // 4) Renderer:隐藏来源添加/删除入口与固定来源页面的冗余说明。
  const addButtonAnchor = "        <Button variant=\"outline\" disabled={pending} icon={<IconPlusOutline16 />} onClick={onAddStandard}>{t('addStandard')}</Button>"
  if (!settingsTab.includes(addButtonAnchor)) {
    throw new Error('prepare-desktop: 未找到市场添加来源按钮锚点，请复查产品源预置覆盖')
  }
  let patchedSettingsTab = settingsTab.replace(
    addButtonAnchor,
    // void 引用保住解构参数：按钮删除后 noUnusedLocals 会拒绝未使用的
    // onAddStandard，而上层调用方仍按接口传入，不宜连根改动。
    '        {void onAddStandard}\n        {/* 产品覆盖：目录源由产品预置，不开放手动添加。 */}',
  )
  const sourceHeadAnchor = "        <div><h2>{t('sources')}</h2><p>{t('sourceNotice')}</p></div>"
  const sourceGuideAnchor = `      <div className="dshMarketBanner dshMarketSourceGuide">
        <IconGlobeOutline14 size={14} />
        <span>
          {t('sourcePartnershipBefore')}
          <a href={DSH_DESKTOP_ISSUES_URL} target="_blank" rel="noopener noreferrer">{t('sourcePartnershipContact')}</a>
          {t('sourcePartnershipAfter')}{' '}
          <a href={adapterGuideHref} target="_blank" rel="noopener noreferrer">{t('sourcePartnershipGuide')}</a>
        </span>
      </div>`
  const removeButtonAnchor = `        <Tooltip label={t('remove')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('remove')}
            disabled={pending}
            icon={<IconTrashOutline16 />}
            onClick={onRemove}
          />
        </Tooltip>`
  for (const [anchor, label] of [
    [sourceHeadAnchor, '来源说明'],
    [sourceGuideAnchor, '来源合作提示'],
    [removeButtonAnchor, '删除来源按钮'],
  ]) {
    if (!patchedSettingsTab.includes(anchor)) {
      throw new Error(`prepare-desktop: 未找到市场${label}锚点，请复查产品源界面覆盖`)
    }
  }
  patchedSettingsTab = patchedSettingsTab
    .replace(sourceHeadAnchor, "        <div><h2>{t('sources')}</h2></div>")
    .replace(
      sourceGuideAnchor,
      '      {void adapterGuideHref}\n      {/* 产品覆盖：固定官方源无需显示合作与接入说明。 */}',
    )
    .replace(
      removeButtonAnchor,
      '        {void onRemove}\n        {/* 产品覆盖：官方目录源不可删除。 */}',
    )
  // 5) Locale:Market 自带独立品牌文案，不会跟随 Desktop productName，
  // 因此中英文副标题都显式切换到用户可见品牌 Tokens Cowork。
  const localeAnchors = [
    [
      "  subtitle: '从你选择的来源发现 DeepSeek Harness 插件',",
      "  subtitle: '从你选择的来源发现 Tokens Cowork 插件',",
    ],
    [
      "  subtitle: 'Discover DeepSeek Harness plugins from sources you choose',",
      "  subtitle: 'Discover Tokens Cowork plugins from sources you choose',",
    ],
  ]
  let patchedLocales = locales
  for (const [anchor, replacement] of localeAnchors) {
    if (!patchedLocales.includes(anchor)) {
      throw new Error('prepare-desktop: 未找到市场品牌副标题锚点，请复查 Market 文案覆盖')
    }
    patchedLocales = patchedLocales.replace(anchor, replacement)
  }
  return {
    index: patchedIndex,
    routes: patchedRoutes,
    sourceStore: patchedSourceStore,
    service: patchedService,
    settingsTab: patchedSettingsTab,
    locales: patchedLocales,
  }
}

/**
 * 跳过与产品源策略冲突的上游市场测试。产品清空了内置合作源目录并预置
 * 自营源，上游"内置源存在/可添加"的断言不再适用；跳过并注明原因，
 * 其余市场测试继续全量执行。
 * @param spec - staging 副本中 tests/host-routes.spec.ts 的完整内容。
 * @returns 适配产品源策略后的测试内容。
 * @throws 上游测试锚点变化时抛出，中断打包待人工复查。
 */
export function skipUpstreamBuiltInSourceTests(spec) {
  const stateAnchor = "  it('returns settings-backed source state with built-in provider metadata', async () => {"
  const eachHead = '  it.each(['
  const eachTail = "] as const)('adds reviewed built-in provider %s as a disabled source', async (key, adapterId, providerId, name) => {"
  if (!spec.includes(stateAnchor) || !spec.includes(eachHead) || !spec.includes(eachTail)) {
    throw new Error('prepare-desktop: 未找到上游内置源测试锚点，请复查市场测试适配')
  }
  // 产品覆盖：内置合作源已移除，相关断言不再适用于产品构建。skip 用
  // it.skip.each 标准形式，保住 each 参数的类型推断。
  return spec
    .replace(stateAnchor, stateAnchor.replace("  it('", "  it.skip('"))
    .replace(eachHead, '  it.skip.each([')
}

/**
 * 跳过 market-runtime 中依赖内置合作源目录的上游测试，理由同上。
 * @param spec - staging 副本中 tests/market-runtime.spec.ts 的完整内容。
 * @returns 适配产品源策略后的测试内容。
 * @throws 上游测试锚点变化时抛出，中断打包待人工复查。
 */
export function skipUpstreamBuiltInRuntimeTests(spec) {
  const anchor = "  it('resolves each built-in mutation through the reviewed provider registry', async () => {"
  if (!spec.includes(anchor)) {
    throw new Error('prepare-desktop: 未找到上游内置源 runtime 测试锚点，请复查市场测试适配')
  }
  // 产品覆盖：内置合作源已移除，相关断言不再适用于产品构建。
  return spec.replace(anchor, anchor.replace("  it('", "  it.skip('"))
}

/**
 * 跳过 client-overlay 中操作来源添加/删除按钮的上游测试。产品隐藏了
 * 这些入口，相应的交互断言不再适用；其余 overlay 测试全量执行。
 * @param spec - staging 副本中 tests/client-overlay.spec.tsx 的完整内容。
 * @returns 适配产品源策略后的测试内容。
 * @throws 上游测试锚点变化时抛出，中断打包待人工复查。
 */
export function skipUpstreamAddSourceOverlayTests(spec) {
  const anchors = [
    "  it('adds a trimmed standard source and closes the dialog on success', async () => {",
    "  it('keeps the standard source dialog open when adding fails', async () => {",
    "  it('removes a source from the source list', async () => {",
  ]
  let patched = spec
  for (const anchor of anchors) {
    if (!patched.includes(anchor)) {
      throw new Error('prepare-desktop: 未找到上游来源操作 overlay 测试锚点，请复查市场测试适配')
    }
    // 产品覆盖：添加来源入口已隐藏，相关交互断言不再适用于产品构建。
    patched = patched.replace(anchor, anchor.replace("  it('", "  it.skip('"))
  }
  return patched
}

/**
 * 跳过 MarketSettingsTab 中要求展示来源合作说明的上游测试。产品使用固定
 * 官方源并隐藏该说明，相应链接断言不再适用；其余设置页测试全量执行。
 * @param spec - staging 副本中 tests/market-settings-tab.spec.tsx 的完整内容。
 * @returns 适配产品固定来源页面后的测试内容。
 * @throws 上游测试锚点变化时抛出，中断打包待人工复查。
 */
export function skipUpstreamSourceDescriptionTests(spec) {
  const anchor = "  it('links source teams to the partnership contact and catalog adapter guide', async () => {"
  if (!spec.includes(anchor)) {
    throw new Error('prepare-desktop: 未找到上游来源说明测试锚点，请复查市场测试适配')
  }
  return spec.replace(anchor, anchor.replace("  it('", "  it.skip('"))
}

/**
 * 为产品 staging 增加历史来源迁移回归测试。旧版本保存的其他来源不应
 * 继续出现在产品界面；迁移后必须只保留产品源，且稳定状态不重复写入。
 * @param spec - staging 副本中 tests/source-store.spec.ts 的完整内容。
 * @returns 增加产品源自愈断言后的测试内容。
 * @throws 上游测试文件结尾变化时抛出，中断打包待人工复查。
 */
export function addRequiredSourceRepairTest(spec) {
  const importAnchor = `import {
  SettingsCatalogSourceStore,`
  const endAnchor = '\n})\n'
  if (!spec.includes(importAnchor) || !spec.endsWith(endAnchor)) {
    throw new Error('prepare-desktop: 市场来源存储测试结构变化，请复查产品源自愈测试')
  }
  const patched = spec.replace(
    importAnchor,
    `import {
  ensureRequiredSource,
  SettingsCatalogSourceStore,`,
  )
  const test = `

  it('replaces persisted legacy sources with the required product source', async () => {
    const legacyManifest = {
      ...manifest,
      providerId: 'org.example.legacy-catalog',
      transport: { ...manifest.transport, endpoint: 'https://legacy.example.org/v1/plugins' },
    }
    const legacySource: LocalSourceRecord = {
      ...source,
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      providerId: legacyManifest.providerId,
      manifestUrl: 'https://legacy.example.org/catalog-source.json',
      manifest: legacyManifest,
    }
    let document: MarketSettingsDocument = { sources: [legacySource] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    await ensureRequiredSource(scope, source)
    expect(document.sources).toEqual([source])
    expect(update).toHaveBeenCalledWith({ sources: [source] })
    await ensureRequiredSource(scope, source)
    expect(document.sources).toEqual([source])
    expect(update).toHaveBeenCalledTimes(1)
  })`
  return `${patched.slice(0, -endAnchor.length)}${test}${endAnchor}`
}

/**
 * 产品入口在异步 effect 中先持久化必需来源，再注册路由。上游生命周期测试
 * 使用同步简化版 Cordis，需要让出一个微任务才能观察到已注册的路由。
 * @param spec - staging 副本中 tests/market-host-lifecycle.spec.ts 的完整内容。
 * @returns 等待产品迁移 setup 后继续原断言的测试内容。
 */
export function awaitProductSourceMigrationInLifecycleTest(spec) {
  const anchor = `    apply(harness.context as never)

    await expect(harness.request(marketRoutes.installable)).resolves.toMatchObject({ status: 503 })`
  const installableAnchor = "    await expect(harness.request(marketRoutes.installable)).resolves.toMatchObject({ status: 404 })"
  if (!spec.includes(anchor) || !spec.includes(installableAnchor)) {
    throw new Error('prepare-desktop: 未找到市场生命周期测试锚点，请复查产品源异步迁移测试')
  }
  return spec
    .replace(
      anchor,
      `    apply(harness.context as never)
    await new Promise<void>(resolve => setImmediate(resolve))

    await expect(harness.request(marketRoutes.installable)).resolves.toMatchObject({ status: 503 })`,
    )
    .replace(installableAnchor, installableAnchor.replace('status: 404', 'status: 200'))
}

/**
 * 市场受控安装与更新：修复产品 npm 包首次安装、市场回执更新和历史
 * 手动安装迁移三条路径。
 *
 * 上游会拒绝任何声明 prepare 的包，而产品的已发布预编译包可能保留仅在
 * publish/pack 阶段使用的 prepare。这里仅对 roster 中明确登记为 npm 的
 * 产品包放行“只有 prepare、没有 preinstall/install/postinstall”的形态；
 * 其余包和其余安装脚本仍按上游策略拒绝。
 *
 * 更新阶段把“同包旧版本 + 更高目录版本”识别为受控更新。已有市场回执
 * 直接复核本地精确包；历史上按提示手动安装的包则先用 npm registry 对旧
 * 版本的仓库、integrity 与 bundle 再做一次完整验证，验证通过后才允许原地
 * 升级并写入市场回执。回执与实际安装漂移时（如历史更新中途失败只升了包
 * 没写回执），同样降级到手动安装复核路径接管，成功后替换陈旧回执自愈。
 * 版本相同或更低仍维持上游的拒绝行为。
 *
 * 独立可删:prepare.mjs 中对应调用删除后,产品回到上游"卸载后重装"语义。
 * @param sources - staging 副本中市场 Host、Renderer 与测试文件的内容。
 * @param managedPackages - market/roster.json 中 npm=true 的产品包名。
 * @returns 改写后的各文件内容。
 * @throws 上游锚点变化时抛出,中断打包待人工复查。
 */
export function enableManagedPluginUpdate(sources, managedPackages) {
  const { installService, settingsTab, locales, installTests, settingsTabTests } = sources
  if (!Array.isArray(managedPackages) || managedPackages.length === 0
    || managedPackages.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error('prepare-desktop: 市场受管 npm 包清单无效')
  }

  /* ---- 0) npm verifier:仅放行产品预编译包的 publish-time prepare ---- */
  const lifecycleAnchor = `      const scripts = manifest.scripts
      if (scripts !== undefined && (
        scripts === null
        || typeof scripts !== 'object'
        || Array.isArray(scripts)
        || LIFECYCLE_SCRIPTS.some(script => own(scripts, script))
      )) {
        throw new MarketInstallError('verification-failed', 'Plugin packages with install lifecycle scripts are not supported.')
      }`
  if (!installService.includes(lifecycleAnchor)) {
    throw new Error('prepare-desktop: 未找到市场生命周期脚本校验锚点，请复查受控安装覆盖')
  }
  const blockedPackagesAnchor = "const BLOCKED_PRODUCT_PACKAGES = new Set(['dsh-plugin-desktop', 'dsh-community-market'])"
  if (!installService.includes(blockedPackagesAnchor)) {
    throw new Error('prepare-desktop: 未找到市场受管产品包常量锚点，请复查受控安装覆盖')
  }
  const productPackagesLiteral = JSON.stringify([...new Set(managedPackages)].sort())
  let patchedInstall = installService.replace(
    blockedPackagesAnchor,
    `const BLOCKED_PRODUCT_PACKAGES = new Set(['dsh-plugin-desktop', 'dsh-community-market'])
// 产品覆盖：仅这些已登记、已发布且仍会经过 registry/repository/integrity 复核的包
// 可以保留 publish-time prepare；真正的安装脚本继续一律拒绝。
const PRODUCT_MANAGED_PACKAGES = new Set<string>(${productPackagesLiteral})`,
  )
  patchedInstall = patchedInstall.replace(
    lifecycleAnchor,
    `      const scripts = manifest.scripts
      const scriptsValid = scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)
      const lifecycleScripts = scriptsValid
        ? LIFECYCLE_SCRIPTS.filter(script => own(scripts, script))
        : []
      const productPublishPrepareOnly = PRODUCT_MANAGED_PACKAGES.has(candidate.packageName)
        && lifecycleScripts.length === 1
        && lifecycleScripts[0] === 'prepare'
        && typeof (scripts as Record<string, unknown>).prepare === 'string'
      if (scripts !== undefined && (!scriptsValid
        || lifecycleScripts.length > 0 && !productPublishPrepareOnly)) {
        throw new MarketInstallError('verification-failed', 'Plugin packages with install lifecycle scripts are not supported.')
      }`,
  )

  /* ---- 1) install/service.ts:预览放行 + 回执携带 + 替换写入 ---- */
  // 预览阶段(previewInstall):旧回执存在且目录版本更高 → 跳过两道闸。
  const previewGateAnchor = `    const profile = this.profile()
    this.assertNoReceipt(profile, candidate.packageName)
    await assertNotInstalled(profile, candidate.packageName)`
  if (!installService.includes(previewGateAnchor)) {
    throw new Error('prepare-desktop: 未找到市场安装预览闸门锚点，请复查受控更新覆盖')
  }
  // 执行阶段(第一处校验):同样放行。上游在执行中段还有一次
  // assertNotInstalled(pnpm 运行前),更新场景下包本就在 profile 里,
  // 也必须一并放行,否则执行必失败。
  const executeGateAnchor = `      this.assertNoReceipt(profile, candidate.packageName)
      await assertNotInstalled(profile, candidate.packageName)`
  const executeMidAnchor = `      await assertNotInstalled(profile, candidate.packageName)
      if (this.candidates.get(candidate.key) !== candidate) {
        throw new MarketInstallError('not-available', 'The catalog source changed before installation.')
      }`
  if (!installService.includes(executeGateAnchor) || !installService.includes(executeMidAnchor)) {
    throw new Error('prepare-desktop: 未找到市场安装执行闸门锚点，请复查受控更新覆盖')
  }
  // 判定函数：先验证严格升版，再验证当前安装确实对应旧版本。无回执的历史
  // 手动安装还必须用 registry 重新证明旧包的 repository/integrity/bundle，
  // 证明通过才允许市场接管。
  const updateHelper = `  private newerVersion(version: string, priorVersion: string): boolean {
    const parse = (value: string) => value.split('.').map(part => Number.parseInt(part, 10))
    const [next, prior] = [parse(version), parse(priorVersion)]
    if (next.length !== 3 || prior.length !== 3 || ![...next, ...prior].every(Number.isFinite)) return false
    for (let index = 0; index < 3; index++) {
      if ((next[index] ?? 0) > (prior[index] ?? 0)) return true
      if ((next[index] ?? 0) < (prior[index] ?? 0)) return false
    }
    return false
  }

  private async updatableInstall(
    profile: MarketDesktopProfile,
    candidate: InstallCandidate,
    signal: AbortSignal,
  ): Promise<{ readonly version: string } | undefined> {
    const receipt = this.receipts().find(existing =>
      existing.profileName === profile.name && existing.packageName === candidate.packageName)
    if (receipt !== undefined) {
      try {
        await assertInstalledBundle(
          profile,
          receipt.packageName,
          receipt.version,
          receipt.bundlePatch,
          receipt.integrity,
        )
        return this.newerVersion(candidate.version, receipt.version) ? receipt : undefined
      } catch {
        signal.throwIfAborted()
        // 回执与实际安装漂移(如历史更新中途失败):不再据此拒绝,落到下方
        // 无回执路径按本地实际版本走 registry 复核,通过则接管;成功更新后
        // 写回执时按包名替换,陈旧回执随之自愈。
      }
    }

    let installedVersion: string | undefined
    try {
      installedVersion = profileDependency(
        await readManifest(join(profile.dir, 'package.json')),
        candidate.packageName,
      )
    } catch {
      signal.throwIfAborted()
      return undefined
    }
    if (!stableExactVersion(installedVersion)
      || !this.newerVersion(candidate.version, installedVersion)) return undefined

    try {
      const verification = await this.verifier.verify(
        { ...candidate, version: installedVersion },
        signal,
      )
      await assertInstalledBundle(
        profile,
        candidate.packageName,
        installedVersion,
        verification.bundlePatch,
        verification.integrity,
      )
      return { version: installedVersion }
    } catch {
      signal.throwIfAborted()
      return undefined
    }
  }

  private assertNoReceipt(`
  const helperAnchor = '  private assertNoReceipt('
  if (!installService.includes(helperAnchor)) {
    throw new Error('prepare-desktop: 未找到市场回执断言锚点，请复查受控更新覆盖')
  }
  // 替换顺序敏感:预览段插入的代码内含执行段锚点字样,必须先替换执行段
  // (原文唯一命中),再替换预览段,否则执行段替换会命中预览段的插入文本。
  patchedInstall = patchedInstall
    .replace(helperAnchor, updateHelper)
    .replace(
      executeGateAnchor,
      `      // 产品覆盖:更新意图下跳过回执与在装闸门(见 previewInstall)。
      const productExecuteUpdate = await this.updatableInstall(profile, candidate, operationSignal)
      if (productExecuteUpdate === undefined) {
        this.assertNoReceipt(profile, candidate.packageName)
        await assertNotInstalled(profile, candidate.packageName)
      }`,
    )
    .replace(
      executeMidAnchor,
      `      if (productExecuteUpdate === undefined) await assertNotInstalled(profile, candidate.packageName)
      if (this.candidates.get(candidate.key) !== candidate) {
        throw new MarketInstallError('not-available', 'The catalog source changed before installation.')
      }`,
    )
    .replace(
      previewGateAnchor,
      `    const profile = this.profile()
    // 产品覆盖:同包旧回执 + 更高版本 = 受控更新,放行重装(pnpm 原地升级)。
    const productUpdateFrom = await this.updatableInstall(profile, candidate, operationSignal)
    if (productUpdateFrom === undefined) {
      this.assertNoReceipt(profile, candidate.packageName)
      await assertNotInstalled(profile, candidate.packageName)
    }`,
    )
  // 预览响应带 updateFrom(旧版本号),前端据此渲染"更新"文案。
  const previewResponseAnchor = `    return {
      intent: token,
      action: 'install',
      profileName: profile.name,
      packageName: candidate.packageName,
      version: candidate.version,
      displayName: candidate.displayName,
      expiresAt: new Date(this.now() + this.intentTtlMs).toISOString(),
    }`
  if (!patchedInstall.includes(previewResponseAnchor)) {
    throw new Error('prepare-desktop: 未找到市场安装预览响应锚点，请复查受控更新覆盖')
  }
  patchedInstall = patchedInstall.replace(
    previewResponseAnchor,
    `    return {
      intent: token,
      action: 'install',
      profileName: profile.name,
      packageName: candidate.packageName,
      version: candidate.version,
      displayName: candidate.displayName,
      expiresAt: new Date(this.now() + this.intentTtlMs).toISOString(),
      ...(productUpdateFrom === undefined ? {} : { updateFrom: productUpdateFrom.version }),
    } as MarketInstallPreview & { updateFrom?: string }`,
  )
  // 安装成功写回执:替换同包旧条目而不是追加(更新后账面版本随之更新)。
  const receiptWriteAnchor = '        await this.saveReceipts([...this.receipts(), receipt])'
  if (!patchedInstall.includes(receiptWriteAnchor)) {
    throw new Error('prepare-desktop: 未找到市场回执写入锚点，请复查受控更新覆盖')
  }
  patchedInstall = patchedInstall.replace(
    receiptWriteAnchor,
    `        await this.saveReceipts([...this.receipts().filter(existing =>
          !(existing.profileName === receipt.profileName && existing.packageName === receipt.packageName)), receipt])`,
  )

  /* ---- 2) MarketSettingsTab.tsx:更新态的标题/说明/按钮文案 ---- */
  // 详情对话框(ItemActionModal)的确认页:标题与描述按 updateFrom 切换。
  const modalTitleAnchor = "      title={preview === undefined ? value.item.displayName : t('confirmInstallTitle')}"
  const modalDescriptionAnchor = "      {...(preview === undefined ? {} : { description: t('confirmInstallBody') })}"
  const modalButtonAnchor = `    >{pending ? t('installing') : t('confirmInstall')}</Button>
  </> : <>`
  const modalFactsAnchor = `            <OperationFacts operation={preview} t={t} />
            <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('operationWarning')}</span></div>`
  const matchingInstallationAnchor = 'function matchingInstallation('
  const inventoryAnchor = `      if (installation !== undefined) setSelectedInstallation(installation)
      else beginInstallPreview()`
  const footerAnchor = '  const footer = installation === undefined && preview !== undefined ? <>'
  const modalProgressAnchor = `{pending && <div className="dshMarketOperationProgress" role="status"><StateDot state="ongoing" size={12} />{t('installing')}</div>}`
  const successTitleAnchor = `  const title = operation.preview.action === 'install'
    ? t('installComplete')`
  if (!settingsTab.includes(modalTitleAnchor) || !settingsTab.includes(modalDescriptionAnchor)
    || !settingsTab.includes(modalButtonAnchor) || !settingsTab.includes(modalFactsAnchor)
    || !settingsTab.includes(matchingInstallationAnchor) || !settingsTab.includes(inventoryAnchor)
    || !settingsTab.includes(footerAnchor) || !settingsTab.includes(modalProgressAnchor)
    || !settingsTab.includes(successTitleAnchor)) {
    throw new Error('prepare-desktop: 未找到市场对话框更新文案锚点，请复查受控更新覆盖')
  }
  const updateFromProbe = '(preview as { updateFrom?: string }).updateFrom'
  const patchedSettingsTab = settingsTab
    .replace(
      matchingInstallationAnchor,
      `function newerStableVersion(nextVersion: string | undefined, priorVersion: string): boolean {
  if (nextVersion === undefined) return false
  const pattern = /^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)$/u
  if (!pattern.test(nextVersion) || !pattern.test(priorVersion)) return false
  const next = nextVersion.split('.').map(Number)
  const prior = priorVersion.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (next[index]! > prior[index]!) return true
    if (next[index]! < prior[index]!) return false
  }
  return false
}

${matchingInstallationAnchor}`,
    )
    .replace(
      inventoryAnchor,
      `      if (installation !== undefined) {
        setSelectedInstallation(installation)
        const managedUpdateAvailable = installation.kind === 'managed'
          && newerStableVersion(value.item.latestVersion, installation.receipt.version)
        // 历史手动安装没有市场回执，Host 会复核本地旧包后决定是否允许接管更新。
        if (managedUpdateAvailable || installation.kind === 'external') beginInstallPreview()
      } else beginInstallPreview()`,
    )
    .replace(footerAnchor, '  const footer = preview !== undefined ? <>')
    .replace(
      modalTitleAnchor,
      `      title={preview === undefined ? value.item.displayName : (${updateFromProbe} === undefined ? t('confirmInstallTitle') : t('confirmUpdateTitle'))}`,
    )
    .replace(
      modalDescriptionAnchor,
      `      {...(preview === undefined ? {} : { description: ${updateFromProbe} === undefined ? t('confirmInstallBody') : t('confirmUpdateBody') })}`,
    )
    .replace(
      modalButtonAnchor,
      `    >{pending
      ? ((preview as { updateFrom?: string } | undefined)?.updateFrom === undefined ? t('installing') : t('updating'))
      : ((preview as { updateFrom?: string } | undefined)?.updateFrom === undefined
        ? t('confirmInstall')
        : t('confirmUpdate') + ' ' + (preview?.version ?? ''))}</Button>
  </> : <>`,
    )
    .replace(
      modalFactsAnchor,
      `            <OperationFacts operation={preview} t={t} />
            {${updateFromProbe} !== undefined && (
              <div className="dshMarketOperationWarning"><StateDot state="ongoing" size={12} /><span>{t('updateFromNotice')} {${updateFromProbe}} {'\\u2192'} {preview.version}</span></div>
            )}
            <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('operationWarning')}</span></div>`,
    )
    .replace(
      modalProgressAnchor,
      `{pending && <div className="dshMarketOperationProgress" role="status"><StateDot state="ongoing" size={12} />{${updateFromProbe} === undefined ? t('installing') : t('updating')}</div>}`,
    )
    .replace(
      successTitleAnchor,
      `  const title = operation.preview.action === 'install'
    ? ((operation.preview as { updateFrom?: string }).updateFrom === undefined ? t('installComplete') : t('updateComplete'))`,
    )

  /* ---- 3) locales.ts:中英文案 ---- */
  const zhAnchor = "  confirmInstall: '确认安装',"
  const enAnchor = "  confirmInstall: 'Confirm install',"
  if (!locales.includes(zhAnchor) || !locales.includes(enAnchor)) {
    throw new Error('prepare-desktop: 未找到市场安装文案锚点，请复查受控更新覆盖')
  }
  const patchedLocales = locales
    .replace(zhAnchor, `${zhAnchor}
  confirmUpdateTitle: '确认更新插件',
  confirmUpdateBody: '请确认 DSH Desktop 验证的 npm 包、版本和目标配置。已安装的旧版本将原地升级。',
  confirmUpdate: '更新到',
  updating: '正在更新…',
  updateFromNotice: '当前已安装',
  updateComplete: '插件更新完成',`)
    .replace(enAnchor, `${enAnchor}
  confirmUpdateTitle: 'Confirm plugin update',
  confirmUpdateBody: 'Review the npm package, version, and target profile verified by DSH Desktop. The installed version is upgraded in place.',
  confirmUpdate: 'Update to',
  updating: 'Updating…',
  updateFromNotice: 'Currently installed',
  updateComplete: 'Plugin updated',`)

  /* ---- 4) 产品回归：prepare 放行、回执更新、手动安装迁移与更新 UI ---- */
  const verifierTestsAnchor = `  })
})

describe('manual install display instructions'`
  const serviceTestsAnchor = `  it('uses one-shot opaque intents, fixed argv, verified bundle state, and profile receipts', async () => {`
  if (!installTests.includes(verifierTestsAnchor) || !installTests.includes(serviceTestsAnchor)) {
    throw new Error('prepare-desktop: 未找到市场受控更新 Host 测试锚点')
  }
  let patchedInstallTests = installTests.replace(
    verifierTestsAnchor,
    `  })

  it('allows only publish-time prepare for roster-managed product packages', async () => {
    const productPackage = '@tokensapi/dsh-progressive-tools'
    const productVersion = '0.1.0'
    const productRepository = { url: 'https://github.com/tokensapi/tokens_dshprogressivetools_code' }
    const productIntegrity = \`sha512-\${Buffer.alloc(64, 3).toString('base64')}\`
    const productTarball = 'https://registry.npmjs.org/@tokensapi/dsh-progressive-tools/-/dsh-progressive-tools-0.1.0.tgz'
    const getJson = vi.fn<(...args: any[]) => Promise<{ finalUrl: string; value: unknown }>>(async () => ({
      finalUrl: \`https://registry.npmjs.org/\${productPackage}/\${productVersion}\`,
      value: {
        name: productPackage,
        version: productVersion,
        repository: { type: 'git', url: 'git+https://github.com/TokensAPI/tokens_DshProgressiveTools_code.git' },
        scripts: { prepare: 'pnpm run build', prepack: 'pnpm run check' },
        dist: { integrity: productIntegrity, tarball: productTarball },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    }))
    const verifier = createNpmRegistryVerifier({ getJson } as unknown as CatalogHttpClient)
    await expect(verifier.verify({
      packageName: productPackage,
      version: productVersion,
      repository: productRepository,
    }, new AbortController().signal)).resolves.toMatchObject({ integrity: productIntegrity })

    getJson.mockResolvedValueOnce({
      finalUrl: \`https://registry.npmjs.org/\${productPackage}/\${productVersion}\`,
      value: {
        name: productPackage,
        version: productVersion,
        repository: productRepository,
        scripts: { prepare: 'pnpm run build', postinstall: 'node unsafe.js' },
        dist: { integrity: productIntegrity, tarball: productTarball },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    })
    await expect(verifier.verify({
      packageName: productPackage,
      version: productVersion,
      repository: productRepository,
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'verification-failed' })
  })
})

describe('manual install display instructions'`,
  )

  const updateServiceTests = `  it('updates a verified market receipt and replaces it with the new exact version', async () => {
    const profileDir = await createProfile()
    const priorVersion = '1.2.2'
    const priorIntegrity = \`sha512-\${Buffer.alloc(64, 2).toString('base64')}\`
    const pluginDir = join(profileDir, 'node_modules', packageName)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'cordis.patch.yml'), '[]\\n')
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: packageName,
      version: priorVersion,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      dependencies: { [packageName]: priorVersion },
      dsh: { profile: { bundles: [packageName] } },
    }))
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { [packageName]: { specifier: priorVersion, version: priorVersion } } } },
      packages: { [\`\${packageName}@\${priorVersion}\`]: { resolution: { integrity: priorIntegrity } } },
      snapshots: { [\`\${packageName}@\${priorVersion}\`]: {} },
    }))
    const priorReceipt: MarketInstallReceipt = {
      receiptId: 'receipt:managed-update-0001',
      profileName: 'web',
      packageName,
      version: priorVersion,
      integrity: priorIntegrity,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'source-1',
      providerId: DSH_1024STORE_PROVIDER_ID,
      itemId: 'example/dsh-plugin-safe',
      displayName: 'Safe Plugin',
      installedAt: '2026-08-18T00:00:00.000Z',
    }
    const settings = memoryScope([priorReceipt])
    const calls: Array<{ args: readonly string[]; dir: string; signal?: AbortSignal }> = []
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, calls),
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())

    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    expect((preview as { updateFrom?: string }).updateFrom).toBe(priorVersion)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).resolves.toMatchObject({
      receipt: { packageName, version },
    })
    expect(settings.receipts()).toHaveLength(1)
    expect(settings.receipts()[0]).toMatchObject({ packageName, version })
    expect(calls[0]?.args.at(-1)).toBe(\`\${packageName}@\${version}\`)
  })

  it('adopts a drifted install when the market receipt no longer matches it', async () => {
    const profileDir = await createProfile()
    const staleVersion = '1.2.1'
    const priorVersion = '1.2.2'
    const priorIntegrity = \`sha512-\${Buffer.alloc(64, 5).toString('base64')}\`
    const pluginDir = join(profileDir, 'node_modules', packageName)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'cordis.patch.yml'), '[]\\n')
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: packageName,
      version: priorVersion,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      dependencies: { [packageName]: priorVersion },
      dsh: { profile: { bundles: [packageName] } },
    }))
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { [packageName]: { specifier: priorVersion, version: priorVersion } } } },
      packages: { [\`\${packageName}@\${priorVersion}\`]: { resolution: { integrity: priorIntegrity } } },
      snapshots: { [\`\${packageName}@\${priorVersion}\`]: {} },
    }))
    // 陈旧回执:记录的是更早的 staleVersion,与 profile 里实际安装的
    // priorVersion 不符(对应"历史更新升了包但没写回执"的漂移现场)。
    const staleReceipt: MarketInstallReceipt = {
      receiptId: 'receipt:stale-drift-0001',
      profileName: 'web',
      packageName,
      version: staleVersion,
      integrity: \`sha512-\${Buffer.alloc(64, 6).toString('base64')}\`,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'source-1',
      providerId: DSH_1024STORE_PROVIDER_ID,
      itemId: 'example/dsh-plugin-safe',
      displayName: 'Safe Plugin',
      installedAt: '2026-08-18T00:00:00.000Z',
    }
    const settings = memoryScope([staleReceipt])
    const verify = vi.fn(async (candidate: { version: string }) => candidate.version === priorVersion
      ? { integrity: priorIntegrity, bundlePatch: './cordis.patch.yml', tarball: 'https://registry.npmjs.org/prior.tgz' }
      : verification)
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      { verify },
    )
    service.observeCatalog(snapshot())

    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    expect((preview as { updateFrom?: string }).updateFrom).toBe(priorVersion)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).resolves.toMatchObject({
      receipt: { packageName, version },
    })
    expect(settings.receipts()).toHaveLength(1)
    expect(settings.receipts()[0]).toMatchObject({ packageName, version })
    expect(verify.mock.calls.some(([candidate]) => candidate.version === priorVersion)).toBe(true)
  })

  it('verifies and adopts a historical manual install before updating it', async () => {
    const profileDir = await createProfile()
    const priorVersion = '1.2.2'
    const priorIntegrity = \`sha512-\${Buffer.alloc(64, 4).toString('base64')}\`
    const pluginDir = join(profileDir, 'node_modules', packageName)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'cordis.patch.yml'), '[]\\n')
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: packageName,
      version: priorVersion,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      dependencies: { [packageName]: priorVersion },
      dsh: { profile: { bundles: [packageName] } },
    }))
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { [packageName]: { specifier: priorVersion, version: priorVersion } } } },
      packages: { [\`\${packageName}@\${priorVersion}\`]: { resolution: { integrity: priorIntegrity } } },
      snapshots: { [\`\${packageName}@\${priorVersion}\`]: {} },
    }))
    const settings = memoryScope()
    const verify = vi.fn(async (candidate: { version: string }) => candidate.version === priorVersion
      ? { integrity: priorIntegrity, bundlePatch: './cordis.patch.yml', tarball: 'https://registry.npmjs.org/prior.tgz' }
      : verification)
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      { verify },
    )
    service.observeCatalog(snapshot())

    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    expect((preview as { updateFrom?: string }).updateFrom).toBe(priorVersion)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).resolves.toMatchObject({
      receipt: { packageName, version },
    })
    expect(settings.receipts()).toHaveLength(1)
    expect(verify.mock.calls.some(([candidate]) => candidate.version === priorVersion)).toBe(true)
  })

`
  patchedInstallTests = patchedInstallTests.replace(serviceTestsAnchor, `${updateServiceTests}${serviceTestsAnchor}`)

  const settingsUpdateTestsAnchor = `  it('ignores a late inventory result after switching the selected catalog item', async () => {`
  if (!settingsTabTests.includes(settingsUpdateTestsAnchor)) {
    throw new Error('prepare-desktop: 未找到市场受控更新 Renderer 测试锚点')
  }
  const updateRendererTest = `  it('previews a newer managed version as an update from the item dialog', async () => {
    const item = makeInstallableItem(firstSource, 'update-plugin', 'Update Plugin', 'dsh-plugin-update', '1.2.3')
    const receipt = makeReceipt({
      packageName: item.package!.name,
      itemId: item.id,
      displayName: item.displayName,
      version: '1.2.2',
    })
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [item]))
    vi.mocked(readMarketInstallations).mockResolvedValue({
      installations: [{ kind: 'managed', status: 'active', action: 'uninstall', receipt }],
    })
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'install',
      profileName: receipt.profileName,
      packageName: receipt.packageName,
      version: item.latestVersion!,
      displayName: item.displayName,
      expiresAt: '2026-08-18T00:05:00.000Z',
      previewId: 'opaque-managed-update-preview',
      updateFrom: receipt.version,
    } as never)
    render(<MarketSettingsTab {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: /Update Plugin/u }))
    await waitFor(() => expect(previewMarketOperation).toHaveBeenCalledWith({
      action: 'install',
      sourceRecordId: firstSource.sourceRecordId,
      itemId: item.id,
    }, expect.any(AbortSignal)))
    const dialog = screen.getByRole('dialog', { name: en.confirmUpdateTitle })
    expect(within(dialog).getByRole('button', { name: \`\${en.confirmUpdate} \${item.latestVersion}\` })).toBeTruthy()
    expect(within(dialog).getByText(new RegExp(\`\${en.updateFromNotice}.*1\\.2\\.2.*1\\.2\\.3\`, 'u'))).toBeTruthy()
  })

`
  const patchedSettingsTabTests = settingsTabTests.replace(
    settingsUpdateTestsAnchor,
    `${updateRendererTest}${settingsUpdateTestsAnchor}`,
  )

  return {
    installService: patchedInstall,
    settingsTab: patchedSettingsTab,
    locales: patchedLocales,
    installTests: patchedInstallTests,
    settingsTabTests: patchedSettingsTabTests,
  }
}
