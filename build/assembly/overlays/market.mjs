/* ============================================================
 * 产品覆盖：插件市场
 * ============================================================
 * 将市场收敛为产品自营目录源：fake-IP 代理豁免、预置 TokensAPI
 * 源并默认选中、清空上游合作源、隐藏手动添加入口。
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
 * 合作源目录、隐藏"添加标准来源"入口。用户打开市场即浏览产品源，无需
 * 手动登记；上游标准源机制本身保持不变（校验、缓存、快照均走原逻辑）。
 * @param sources - staging 副本中市场各文件的内容。
 * @param origin - 产品目录源 origin（来自 market/source.config.json）。
 * @param manifest - 产品目录源 manifest 的完整 JSON 对象（market/source.json）。
 * @returns 改写后的各文件内容。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function pinProductMarketSource(sources, origin, manifest) {
  const { routes, service, settingsTab } = sources
  // 1) Host:设置 schema 的 sources 默认值从 [] 换成预置的产品源记录。
  //    记录形状须过 validateLocalSourceRecords:user-added + manifestUrl +
  //    注册时 manifest 快照 + UUID。UUID 在装配时固定生成,同一版本安装包
  //    内一致;用户侧首次读取即落库,与手动添加的记录无区别。
  const defaultsAnchor = '  sources: z.array(SOURCE_SCHEMA).default([]),'
  if (!routes.includes(defaultsAnchor)) {
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
  const patchedRoutes = routes.replace(
    defaultsAnchor,
    '  // 产品覆盖：预置 TokensAPI 官方目录源并默认选中。\n'
    + `  sources: z.array(SOURCE_SCHEMA).default(${JSON.stringify([seededRecord])} as never),`,
  )
  // 2) Host:清空内置合作源目录(1024Store/dshfind 不再出现在可添加列表)。
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
  // 3) Renderer:隐藏"添加标准来源"按钮,用户不再手动登记源。
  const addButtonAnchor = "        <Button variant=\"outline\" disabled={pending} icon={<IconPlusOutline16 />} onClick={onAddStandard}>{t('addStandard')}</Button>"
  if (!settingsTab.includes(addButtonAnchor)) {
    throw new Error('prepare-desktop: 未找到市场添加来源按钮锚点，请复查产品源预置覆盖')
  }
  const patchedSettingsTab = settingsTab.replace(
    addButtonAnchor,
    // void 引用保住解构参数：按钮删除后 noUnusedLocals 会拒绝未使用的
    // onAddStandard，而上层调用方仍按接口传入，不宜连根改动。
    '        {void onAddStandard}\n        {/* 产品覆盖：目录源由产品预置，不开放手动添加。 */}',
  )
  return { routes: patchedRoutes, service: patchedService, settingsTab: patchedSettingsTab }
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
 * 跳过 client-overlay 中操作"添加标准来源"按钮的上游测试。产品隐藏了
 * 该入口，相应的对话框交互断言不再适用；其余 overlay 测试全量执行。
 * @param spec - staging 副本中 tests/client-overlay.spec.tsx 的完整内容。
 * @returns 适配产品源策略后的测试内容。
 * @throws 上游测试锚点变化时抛出，中断打包待人工复查。
 */
export function skipUpstreamAddSourceOverlayTests(spec) {
  const anchors = [
    "  it('adds a trimmed standard source and closes the dialog on success', async () => {",
    "  it('keeps the standard source dialog open when adding fails', async () => {",
  ]
  let patched = spec
  for (const anchor of anchors) {
    if (!patched.includes(anchor)) {
      throw new Error('prepare-desktop: 未找到上游添加来源 overlay 测试锚点，请复查市场测试适配')
    }
    // 产品覆盖：添加来源入口已隐藏，相关交互断言不再适用于产品构建。
    patched = patched.replace(anchor, anchor.replace("  it('", "  it.skip('"))
  }
  return patched
}
