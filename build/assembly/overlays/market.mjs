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
  //    完成，通用 store/load 与上游路由测试保持原语义。
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
  const retained = records
    .filter(record => !isRequired(record))
    .sort((left, right) => left.order - right.order)
    .map((record, index) => ({ ...record, enabled: false, order: index + 1 }))
  const repaired = [required, ...retained]
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
 * 为产品 staging 增加持久化空来源的回归测试。该状态来自旧版本中用户已
 * 删除官方源的配置，重新安装仍会保留；迁移函数必须补回且只写一次。
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

  it('restores a required product source from persisted empty settings', async () => {
    let document: MarketSettingsDocument = { sources: [] }
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
