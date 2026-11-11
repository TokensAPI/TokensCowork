// 插件文档入口（用户 2026-11-11）：插件市场右上角的「当前来源」和每张卡片底部的「来源」改成
// 「TokensCowork」，点击在浏览器里打开插件文档中心（market/server 的 /docs），并且已经登录。
// Key 不进网址：市场插件的宿主侧用当前的 TokensAPI Key 向市场服务换一个 60 秒内有效、只能用一次
// 的登录码（POST /v1/docs/codes），打开 /docs?code=…#/<插件ID>，页面用登录码换回 Key 并把登录码
// 从地址栏去掉。换不到登录码（没有 Key、网络失败）时照样打开文档中心，由用户手动登录。
import { insertBefore, replaceOnce } from '../../pipeline/anchors.mjs'

export const DOCS_LINK_ROUTE = '/api/community-market/docs/link'
const LABEL = 'market docs link'

/** 宿主路由：用当前 Key 换登录码，回给渲染层要打开的地址。 */
function addDocsLinkRoute(routes, origin) {
  routes = replaceOnce(routes, "const ROUTE_SOURCES = '/api/community-market/sources'\n",
    `const ROUTE_SOURCES = '/api/community-market/sources'\nconst ROUTE_DOCS_LINK = '${DOCS_LINK_ROUTE}'\n`, LABEL)
  return replaceOnce(routes, '    }}),\n  ]\n  if (desktopActionsProvider !== undefined) {', `    }}),
    // Product overlay: the plugin docs center, opened in the browser already signed in. The Key
    // never leaves this process except to the market itself, which trades it for a code that
    // works once within 60 seconds; only the code goes into the address.
    ctx.webServer.register({ kind: 'exact', path: ROUTE_DOCS_LINK, handler: async (req, res) => {
      if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
        sendJson(res, 405, { error: 'opening the docs requires a local same-origin POST' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal, AbortSignal.timeout(10000)])
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const request = await readJson(req, signal) as { readonly pluginId?: unknown }
        const pluginId = typeof request?.pluginId === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(request.pluginId) ? request.pluginId : ''
        const target = new URL('/docs', ${JSON.stringify(origin)})
        target.hash = '/' + pluginId
        const key = await readMarketKey()
        if (key) {
          try {
            const response = await fetch(new URL('/v1/docs/codes', ${JSON.stringify(origin)}), {
              method: 'POST', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, signal,
            })
            const issued = response.ok ? await response.json() as { readonly code?: unknown } : undefined
            if (typeof issued?.code === 'string' && /^[a-f0-9]{64}$/u.test(issued.code)) target.searchParams.set('code', issued.code)
          } catch {
            // No code: the docs center still opens and asks the reader to sign in.
          }
        }
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, { url: target.href })
      } catch (cause) {
        if (!signal.aborted && !res.destroyed) sendJson(res, 400, { error: cause instanceof Error ? cause.message : 'docs link failed' })
      } finally {
        stopWatching()
      }
    }}),
  ]
  if (desktopActionsProvider !== undefined) {`, LABEL)
}

/** 客户端 API：要打开的文档地址。 */
function addDocsLinkCall(api) {
  return insertBefore(api, 'export async function setMarketInstallationEnabled(',
    `/** Product overlay: the docs center address for one plugin, or the overview, signed in through a one-time code. */
export async function openMarketDocsLink(pluginId?: string, signal?: AbortSignal): Promise<{ readonly url: string }> {
  return await readJson(await fetch('${DOCS_LINK_ROUTE}', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pluginId === undefined ? {} : { pluginId }),
    ...(signal === undefined ? {} : { signal }),
  }))
}

`, LABEL)
}

/** 渲染层：右上角与卡片上的「TokensCowork」，点击打开文档。 */
function linkSourcesToDocs(settingsTab, origin) {
  settingsTab = replaceOnce(settingsTab, '  openMarketTerminal,\n', '  openMarketDocsLink,\n  openMarketTerminal,\n', LABEL)
  settingsTab = insertBefore(settingsTab, '\nfunction DiscoverView(', `
const DOCS_ORIGIN = ${JSON.stringify(origin)}
/**
 * Product overlay: open the plugin docs center in the browser, signed in as this TokensCowork user.
 * Only an address on the docs center itself is opened, whatever the Host answers.
 */
async function openMarketDocs(pluginId?: string): Promise<void> {
  let url = DOCS_ORIGIN + '/docs#/' + (pluginId ?? '')
  try {
    const answer = (await openMarketDocsLink(pluginId)).url
    if (typeof answer === 'string' && answer.startsWith(DOCS_ORIGIN + '/docs')) url = answer
  } catch {
    // Signed out or offline: open the docs center anyway; it asks for the Key itself.
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
`, LABEL)
  // 右上角：不再指向来源主页，改为文档中心。
  settingsTab = replaceOnce(settingsTab, `            : currentSourceHref === undefined
              ? \`\${t('currentSource')}: \${currentSource.name}\`
              : (
                <a href={currentSourceHref} target="_blank" rel="noopener noreferrer">
                  {t('currentSource')}: {currentSource.name} <IconRightUpOutlineRegular size={12} />
                </a>
              )}`, `            : (
                <a href={DOCS_ORIGIN + '/docs'} title={t('openDocs')} onClick={event => { event.preventDefault(); void openMarketDocs() }}>
                  {t('currentSource')}: TokensCowork <IconRightUpOutlineRegular size={12} />
                </a>
              )}`, LABEL)
  settingsTab = replaceOnce(settingsTab, `  const currentSourceHref = currentSource === undefined
    ? undefined
    : safeHttpsExternalHref(currentSource.homepage) ?? safeHttpsExternalHref(currentSource.attribution?.url)
`, '', LABEL)
  // 卡片底部：「来源: TokensCowork」，点它打开这个插件的文档，不打开卡片的详情。
  settingsTab = replaceOnce(settingsTab, '  const sourceLabel = sourceDisplayLabel(value.source)\n', '', LABEL)
  return replaceOnce(settingsTab, "        <Pill>{t('source')}: {sourceLabel}</Pill>\n",
    `        <span className="dshMarketDocsLink" title={t('openDocs')} onClick={event => { event.stopPropagation(); void openMarketDocs(value.item.id) }}>
          <Pill>{t('source')}: TokensCowork</Pill>
        </span>
`, LABEL)
}

const DOCS_LINK_STYLES = `.dshMarketDocsLink {
  display: inline-flex;
  flex: none;
  cursor: pointer;
}

.dshMarketDocsLink:hover > * {
  color: var(--dsw-alias-label-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

`

const MESSAGES = { zh: '查看使用文档', en: 'Open the plugin docs' }

/**
 * 插件文档入口：宿主路由、客户端调用、两处「TokensCowork」、样式与文案。
 * @param input - staging 中市场的宿主路由、客户端 API、设置面板、样式与文案。
 * @param origin - 产品市场的 HTTPS origin（与插件目录同一个）。
 * @returns 改写后的五个文件内容。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function addMarketDocsLink(input, origin) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('market docs link: HTTPS origin required')
  let { routes, api, settingsTab, styles, locales } = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.replaceAll('\r\n', '\n')]))
  routes = addDocsLinkRoute(routes, origin)
  api = addDocsLinkCall(api)
  settingsTab = linkSourcesToDocs(settingsTab, origin)
  styles = insertBefore(styles, '.dshMarketCard:hover {', DOCS_LINK_STYLES, LABEL)
  for (const [language, anchor] of [['zh', "  tab: '插件市场',\n"], ['en', "  tab: 'Plugin Market',\n"]]) {
    locales = replaceOnce(locales, anchor, `${anchor}  openDocs: '${MESSAGES[language]}',\n`, LABEL)
  }
  return { routes, api, settingsTab, styles, locales }
}

/** 上游设置面板用例：来源链接与卡片来源的文字换成 TokensCowork；补上产品回归。须排在其他面板用例适配之后。 */
export function adaptDocsLinkSettingsTests(tests) {
  tests = tests.replaceAll('\r\n', '\n')
  const swaps = [
    ['  requestMarketRestart: vi.fn(),\n', '  requestMarketRestart: vi.fn(),\n  openMarketDocsLink: vi.fn(),\n'],
    [`    const currentSourceLink = screen.getByRole('link', { name: \`\${en.currentSource}: \${firstSource.name}\` }) as HTMLAnchorElement
    expect(currentSourceLink.href).toBe('https://catalog.example/')
    expect(currentSourceLink.target).toBe('_blank')
    expect(currentSourceLink.rel).toContain('noopener')
    expect(screen.getByText(\`\${en.source}: Fixture catalog · Fixture provider\`)).toBeTruthy()
`, `    // 产品覆盖：右上角与卡片来源指向 TokensCowork 插件文档。
    expect(screen.getByRole('link', { name: \`\${en.currentSource}: TokensCowork\` })).toBeTruthy()
    expect(within(plugin).getByText(\`\${en.source}: TokensCowork\`)).toBeTruthy()
`],
    // 详情里的来源行照旧（下一句核对它的链接）；卡片上那一行已改成 TokensCowork。
    ["    expect(screen.getByText(`${en.source}: Fixture catalog · Fixture provider`)).toBeTruthy()\n    expect(within(screen.getByRole('dialog')).getByRole('link', {\n",
      "    expect(within(screen.getByRole('dialog')).getByRole('link', {\n"],
    ["    expect(screen.getByText(`${en.currentSource}: ${second.name}`)).toBeTruthy()\n",
      "    // 产品覆盖：来源固定显示为 TokensCowork（文档入口），切换由列表内容体现。\n    expect(screen.getByText(`${en.currentSource}: TokensCowork`)).toBeTruthy()\n"],
  ]
  for (const [from, to] of swaps) tests = replaceOnce(tests, from, to, 'market settings tab test')
  tests = replaceOnce(tests, "import { en, type MarketLocaleKey } from '../src/client/locales.js'\n",
    "import { en, type MarketLocaleKey } from '../src/client/locales.js'\nimport { openMarketDocsLink } from '../src/client/api.js'\n", 'market settings tab test')
  return tests + `
describe('product plugin docs links', () => {
  const docsItem = makeInstallableItem(firstSource, 'docs-card', 'Docs Card', '@tokensapi/docs-card')
  const docsProps = { t, readLocale: () => 'en' } as MarketSettingsTabProps
  function browseDocs() {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [docsItem]))
  }

  it('opens a card\\'s plugin docs signed in, without opening the card', async () => {
    browseDocs()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(openMarketDocsLink).mockResolvedValue({ url: 'https://market.tokensapi.ai/docs?code=${'a'.repeat(64)}#/docs-card' })
    render(<MarketSettingsTab {...docsProps} />)
    const card = await screen.findByRole('button', { name: /Docs Card/u })
    fireEvent.click(within(card).getByText(\`\${en.source}: TokensCowork\`))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://market.tokensapi.ai/docs?code=${'a'.repeat(64)}#/docs-card', '_blank', 'noopener,noreferrer'))
    expect(openMarketDocsLink).toHaveBeenCalledWith('docs-card')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the docs overview from the source link and never an address off the docs center', async () => {
    browseDocs()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(openMarketDocsLink).mockResolvedValue({ url: 'https://evil.example/docs' })
    render(<MarketSettingsTab {...docsProps} />)
    await screen.findByRole('button', { name: /Docs Card/u })
    fireEvent.click(screen.getByRole('link', { name: \`\${en.currentSource}: TokensCowork\` }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://market.tokensapi.ai/docs#/', '_blank', 'noopener,noreferrer'))
    expect(openMarketDocsLink).toHaveBeenCalledWith(undefined)
  })

  it('still opens the docs center when no sign-in code can be had', async () => {
    browseDocs()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(openMarketDocsLink).mockRejectedValue(new Error('offline'))
    render(<MarketSettingsTab {...docsProps} />)
    const card = await screen.findByRole('button', { name: /Docs Card/u })
    fireEvent.click(within(card).getByText(\`\${en.source}: TokensCowork\`))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://market.tokensapi.ai/docs#/docs-card', '_blank', 'noopener,noreferrer'))
  })
})
`
}

/** 宿主路由的产品回归：Key 只发给市场换登录码，地址里只有登录码；换不到时照样给地址。 */
const RUNTIME_TESTS = `
describe('product plugin docs link route', () => {
  type RouteHandler = (req: EventEmitter & Record<string, any>, res: EventEmitter & Record<string, any>) => Promise<void>
  const CODE = 'c'.repeat(64)

  function harness(key: string | undefined) {
    const handlers = new Map<string, RouteHandler>()
    const ctx = {
      webServer: { port: 43_120, register: vi.fn((route: { path: string; handler: RouteHandler }) => { handlers.set(route.path, route.handler); return vi.fn() }) },
      reflect: { get: (name: string) => name === 'credentials' && key !== undefined ? { resolve: async () => ({ value: key }) } : undefined },
    }
    const state: MarketStateStore = { getSources: () => [], setSources: vi.fn(async () => {}), getCatalogCache: () => undefined, setCatalogCache: vi.fn(async () => {}) }
    const dispose = registerMarketRoutes(ctx as never, state)
    async function call(body: unknown, method = 'POST') {
      const request = Object.assign(new EventEmitter(), {
        method, url: '${DOCS_LINK_ROUTE}',
        headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120', 'content-type': 'application/json' },
        socket: { remoteAddress: '127.0.0.1' },
      })
      let sent = ''
      const response = Object.assign(new EventEmitter(), {
        destroyed: false, writableEnded: false, statusCode: 0, setHeader: vi.fn(), removeHeader: vi.fn(),
        end: vi.fn((value: string) => { sent = value }),
      })
      const pending = handlers.get('${DOCS_LINK_ROUTE}')!(request, response)
      request.emit('data', Buffer.from(JSON.stringify(body)))
      request.emit('end')
      await pending
      return { status: response.statusCode, body: sent ? JSON.parse(sent) : undefined }
    }
    return { call, dispose }
  }

  it('trades the Key for a one-time code and puts only the code in the address', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: CODE, expiresIn: 60 }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { call, dispose } = harness('sk-reader-key')
    const answer = await call({ pluginId: 'tokens-meeting-transcription' })
    expect(answer.status).toBe(200)
    expect(answer.body.url).toBe('https://market.tokensapi.ai/docs?code=' + CODE + '#/tokens-meeting-transcription')
    expect(answer.body.url).not.toContain('sk-reader-key')
    const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(target)).toBe('https://market.tokensapi.ai/v1/docs/codes')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-reader-key')
    dispose()
    vi.unstubAllGlobals()
  })

  it('still answers with the docs address when there is no Key or no code', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetch)
    const signedOut = harness(undefined)
    expect((await signedOut.call({ pluginId: 'tokens-connect' })).body.url).toBe('https://market.tokensapi.ai/docs#/tokens-connect')
    expect(fetch).not.toHaveBeenCalled()
    signedOut.dispose()
    const offline = harness('sk-reader-key')
    expect((await offline.call({})).body.url).toBe('https://market.tokensapi.ai/docs#/')
    // A plugin id that is not one is dropped, not passed into the address.
    expect((await offline.call({ pluginId: '../admin' })).body.url).toBe('https://market.tokensapi.ai/docs#/')
    expect((await offline.call({}, 'GET')).status).toBe(405)
    offline.dispose()
    vi.unstubAllGlobals()
  })
})
`

/** 上游运行时用例按个数断言宿主注册的路由；产品多注册一个文档入口。另补上这个路由的回归。 */
export function adaptDocsLinkRuntimeTests(tests) {
  tests = replaceOnce(tests.replaceAll('\r\n', '\n'), '    expect(routeDisposers).toHaveLength(4)\n',
    '    // 产品覆盖：多一个插件文档入口路由。\n    expect(routeDisposers).toHaveLength(5)\n', 'market runtime test')
  return tests + RUNTIME_TESTS
}

/** 上游浮层用例：切换来源后右上角固定显示 TokensCowork。 */
export function adaptDocsLinkOverlayTests(tests) {
  return replaceOnce(tests.replaceAll('\r\n', '\n'), "    expect(await screen.findByText('currentSource: Second catalog')).toBeTruthy()\n",
    "    // 产品覆盖：来源固定显示为 TokensCowork（文档入口）。\n    expect(await screen.findByText('currentSource: TokensCowork')).toBeTruthy()\n", 'market overlay test')
}
