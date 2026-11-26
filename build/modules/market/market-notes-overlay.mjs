// 插件更新说明（T0114，方案 agent-hub/docs/release-notes-plan.md「约定」）：插件详情与「确认更新插件」
// 对话框列出每一版改了什么，参照应用商店的「新版本说明」。说明由市场服务按版本保存（中文、英文各一份），
// 读取接口是 GET <市场>/v1/plugins/<itemId>/notes?from=&to=，鉴权与可见性同 /v1/plugins。
// 渲染层不直接访问市场：宿主侧新增一个本地路由，用产品目录同一个受限客户端去读（Key 由 market.auth
// 的授权钩子附加，notes 路径已纳入），只把版本、日期与两种语言的正文交回渲染层。说明按纯文本与安全
// 子集（段落、「- 」列表、**加粗**、`代码`）渲染成 React 节点，从不当 HTML 解析。
// 读不到说明（未登录、离线、超时、服务端旧版本）只影响这一块，安装与更新照常可点。
import { insertAfter, insertBefore, replaceOnce } from '../../pipeline/anchors.mjs'

export const PLUGIN_NOTES_ROUTE = '/api/community-market/plugin-notes'
const LABEL = 'market plugin notes'

/** 一段按块切开的边界：函数从 `function <name>(` 到下一个顶层函数（ItemActionModal 是文件里最后一个）。 */
function sliceFunction(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`)
  if (start < 0) throw new Error(`${LABEL}: ${name} boundary changed`)
  const end = source.indexOf('\nfunction ', start + 1)
  return [start + 1, end < 0 ? source.length : end]
}

function patchFunction(source, name, patch) {
  const [start, end] = sliceFunction(source, name)
  return source.slice(0, start) + patch(source.slice(start, end)) + source.slice(end)
}

const TYPES = String.raw`
/** Product overlay: one version's release notes as the market stores them (plain text or a safe Markdown subset). */
export interface MarketPluginNote {
  readonly version: string
  readonly publishedAt: string | null
  readonly zh: string | null
  readonly en: string | null
}

/** Product overlay: the notes of the versions after ` + '`from`' + String.raw` up to ` + '`to`' + String.raw`, newest first. */
export interface MarketPluginNotesResponse {
  readonly items: readonly MarketPluginNote[]
}
`

/** 宿主侧：校验参数、把包名换成目录里的插件 ID、经受限客户端读市场，回给渲染层的只有这几个字段。 */
const HOST_HELPERS = String.raw`/** Product overlay: an exact version as the market's notes endpoint accepts it. */
function pluginNotesVersion(value: string | null): value is string {
  return value !== null && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
}

/** Product overlay: the market's answer reduced to what the client renders, bounded in count and size. */
function pluginNotesItems(value: unknown): readonly MarketPluginNote[] {
  const items = typeof value === 'object' && value !== null ? (value as { readonly items?: unknown }).items : undefined
  if (!Array.isArray(items)) throw new Error('invalid plugin notes response')
  const text = (note: unknown): string | null => typeof note === 'string' && note.trim() !== '' ? note.slice(0, 8000) : null
  return items.slice(0, 20).flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const entry = item as Record<string, unknown>
    const version = typeof entry.version === 'string' ? entry.version : null
    if (!pluginNotesVersion(version)) return []
    return [{
      version,
      publishedAt: typeof entry.publishedAt === 'string' && entry.publishedAt.length <= 40 ? entry.publishedAt : null,
      zh: text(entry.zh),
      en: text(entry.en),
    }]
  })
}

`

const HOST_ROUTE = String.raw`    }}),
    // Product overlay: per-version release notes for a plugin's details and its update
    // confirmation, read from the market with the same restricted client (and the same Key
    // hook) as the catalog. A failure answers 502 and the client shows that the notes are
    // unavailable; it never blocks an install or an update.
    ctx.webServer.register({ kind: 'exact', path: ROUTE_PLUGIN_NOTES, handler: async (req, res) => {
      if (req.method !== 'GET' || !requestAllowed(req, expectedPort)) {
        sendJson(res, 405, { error: 'plugin notes require a local GET' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal, AbortSignal.timeout(10000)])
      const stopWatching = abortOnDisconnect(req, res, controller)
      const answer = (status: number, value: unknown) => {
        if (!controller.signal.aborted && !generationController.signal.aborted && !res.destroyed) sendJson(res, status, value)
      }
      try {
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams
        const to = query.get('to')
        const from = query.get('from')
        if (!pluginNotesVersion(to) || (from !== null && !pluginNotesVersion(from))) {
          answer(400, { error: 'plugin notes need exact versions' })
          return
        }
        let itemId = query.get('itemId') ?? undefined
        const packageName = query.get('packageName')
        if (itemId === undefined && packageName !== null) {
          const index = await service.scanCatalog(signal)
          itemId = index?.snapshots.flatMap(snapshot => snapshot.items).find(item => item.package?.name === packageName)?.id
        }
        if (itemId === undefined || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(itemId)) {
          answer(404, { error: 'this plugin is not in the market catalog' })
          return
        }
        const target = new URL('/v1/plugins/' + encodeURIComponent(itemId) + '/notes', __MARKET_ORIGIN__)
        if (from !== null) target.searchParams.set('from', from)
        target.searchParams.set('to', to)
        const response = await restrictedHttpClient.getJson(target.href, signal, { allowedOrigin: __MARKET_ORIGIN__ })
        answer(200, { items: pluginNotesItems(response.value) })
      } catch {
        answer(502, { error: 'plugin notes unavailable' })
      } finally {
        stopWatching()
      }
    }}),
  ]
  if (desktopActionsProvider !== undefined) {`

function addNotesRoute(routes, origin) {
  routes = insertAfter(routes, "const ROUTE_SOURCES = '/api/community-market/sources'\n",
    `const ROUTE_PLUGIN_NOTES = '${PLUGIN_NOTES_ROUTE}'\n`, LABEL)
  routes = insertAfter(routes, "import { manualInstallHints } from '../install/manual.js'\n",
    "import type { MarketPluginNote } from '../api-types.js'\n", LABEL)
  routes = insertBefore(routes, 'export function registerMarketRoutes(', HOST_HELPERS, LABEL)
  return replaceOnce(routes, '    }}),\n  ]\n  if (desktopActionsProvider !== undefined) {',
    HOST_ROUTE.replaceAll('__MARKET_ORIGIN__', JSON.stringify(origin)), LABEL)
}

const API_CALL = String.raw`/** Product overlay: one plugin's per-version release notes, read through the Host from the market. */
export async function readMarketPluginNotes(
  request: { readonly itemId?: string; readonly packageName?: string; readonly from?: string; readonly to: string },
  signal?: AbortSignal,
): Promise<MarketPluginNotesResponse> {
  const url = new URL('${PLUGIN_NOTES_ROUTE}', window.location.origin)
  if (request.itemId !== undefined) url.searchParams.set('itemId', request.itemId)
  if (request.packageName !== undefined) url.searchParams.set('packageName', request.packageName)
  if (request.from !== undefined) url.searchParams.set('from', request.from)
  url.searchParams.set('to', request.to)
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

`.replace('${PLUGIN_NOTES_ROUTE}', PLUGIN_NOTES_ROUTE)

function addNotesCall(api) {
  api = insertBefore(api, '\nconst CATALOG_PAGE_LIMIT = 50', "import type { MarketPluginNotesResponse } from '../api-types.js'\n", LABEL)
  return insertBefore(api, 'export async function readMarketInstallations(', API_CALL, LABEL)
}

/**
 * 渲染层组件。正文只按安全子集切成段落、列表、加粗与行内代码，全部作为 React 文本节点输出，
 * 不经过 innerHTML，所以说明里的任何标签都原样显示成文字。反引号用 \u0060 写，免得和外层模板冲突。
 */
const COMPONENT = String.raw`
/** Product overlay: which plugin and version range a release-notes request names. */
interface PluginNotesRequest {
  readonly itemId?: string
  readonly packageName?: string
  readonly from?: string
  readonly to: string
}

type PluginNotesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly MarketPluginNote[] }
  | { readonly status: 'failed' }

const PLUGIN_NOTES_TIMEOUT_MS = 15000

/** Product overlay: the notes for one request; any failure or a timeout settles as 'failed'. */
function usePluginNotes(request: PluginNotesRequest): PluginNotesState {
  const key = JSON.stringify([request.itemId ?? '', request.packageName ?? '', request.from ?? '', request.to])
  const [state, setState] = useState<{ readonly key: string; readonly value: PluginNotesState }>({ key: '', value: { status: 'loading' } })
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PLUGIN_NOTES_TIMEOUT_MS)
    void (async () => {
      try {
        const response = await readMarketPluginNotes(request, controller.signal)
        if (controller.signal.aborted || !Array.isArray(response?.items)) throw new Error('plugin notes unavailable')
        if (!cancelled) setState({ key, value: { status: 'ready', items: response.items } })
      } catch {
        if (!cancelled) setState({ key, value: { status: 'failed' } })
      } finally {
        clearTimeout(timer)
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [key])
  return state.key === key ? state.value : { status: 'loading' }
}

/** Product overlay: what the plugin details ask for: the pending update's range, else the current or latest version. */
function detailNotesRequest(value: VisibleItem, installation: MarketInstallationView | undefined): PluginNotesRequest | undefined {
  const itemId = value.item.id
  if (installation?.version !== undefined) {
    return installation.updateStatus === 'available' && installation.updateVersion !== undefined && installation.updateVersion !== installation.version
      ? { itemId, from: installation.version, to: installation.updateVersion }
      : { itemId, to: installation.version }
  }
  return value.item.latestVersion === undefined ? undefined : { itemId, to: value.item.latestVersion }
}

/** Product overlay: a publication time as a local calendar date, or nothing when it cannot be read. */
function pluginNoteDate(value: string | null): string | undefined {
  if (value === null) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const pad = (part: number) => String(part).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/** Product overlay: **bold** and \u0060code\u0060 inside one line, everything else as text. */
function pluginNoteInline(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|\u0060[^\u0060\n]+\u0060)/u).filter(part => part !== '').map((part, index) =>
    part.length > 4 && part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.length > 2 && part.startsWith('\u0060') && part.endsWith('\u0060')
        ? <code key={index}>{part.slice(1, -1)}</code>
        : part)
}

type PluginNoteBlock =
  | { readonly kind: 'paragraph'; readonly lines: string[] }
  | { readonly kind: 'list'; readonly items: { text: string; nested: boolean }[] }

/** Product overlay: the safe subset (paragraphs, "- " lists, **bold**, \u0060code\u0060) as React nodes; HTML stays text. */
function PluginNoteText({ text }: { text: string }) {
  const blocks: PluginNoteBlock[] = []
  let current: PluginNoteBlock | undefined
  for (const raw of text.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      current = undefined
      continue
    }
    const item = /^(\s*)[-*+]\s+(.*)$/u.exec(line)
    if (item !== null) {
      if (current?.kind !== 'list') {
        current = { kind: 'list', items: [] }
        blocks.push(current)
      }
      current.items.push({ text: item[2] ?? '', nested: (item[1] ?? '').length >= 2 })
      continue
    }
    const lastItem = current?.kind === 'list' ? current.items[current.items.length - 1] : undefined
    if (lastItem !== undefined && /^\s/u.test(line)) {
      lastItem.text += ' ' + line.trim()
      continue
    }
    if (current?.kind !== 'paragraph') {
      current = { kind: 'paragraph', lines: [] }
      blocks.push(current)
    }
    current.lines.push(line.trim())
  }
  return (
    <div className="dshMarketNoteText">
      {blocks.map((block, index) => block.kind === 'list'
        ? <ul key={index}>{block.items.map((entry, position) => (
            <li key={position} className={entry.nested ? 'dshMarketNoteNested' : undefined}>{pluginNoteInline(entry.text)}</li>
          ))}</ul>
        : <p key={index}>{pluginNoteInline(block.lines.join('\n'))}</p>)}
    </div>
  )
}

/** Product overlay: one version's entry, in the interface language when there is one, else the other with a note. */
function PluginNoteEntry({ note, language, t }: {
  note: MarketPluginNote
  language: 'zh' | 'en'
  t: MarketSettingsTabProps['t']
}) {
  const own = note[language]?.trim() || undefined
  const other = note[language === 'zh' ? 'en' : 'zh']?.trim() || undefined
  const text = own ?? other
  const date = pluginNoteDate(note.publishedAt)
  return (
    <li className="dshMarketNote">
      <div className="dshMarketNoteHead">
        <strong>{'v' + note.version}</strong>
        {date !== undefined && <span>{date}</span>}
        {own === undefined && other !== undefined && <span className="dshMarketNoteLanguage">{t('notesOtherLanguage')}</span>}
      </div>
      {text === undefined ? <p className="dshMarketNotesMuted">{t('notesEmpty')}</p> : <PluginNoteText text={text} />}
    </li>
  )
}

/**
 * Product overlay: "What's New" for a plugin, newest version first. In the details it folds
 * past a few lines and can be expanded; in the update confirmation it scrolls in place.
 */
function PluginNotes({ request, locale, collapsible = false, t }: {
  request: PluginNotesRequest
  locale: string | undefined
  collapsible?: boolean
  t: MarketSettingsTabProps['t']
}) {
  const state = usePluginNotes(request)
  const language = (locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const body = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const element = body.current
    if (!collapsible || expanded || element === null) return
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [collapsible, expanded, state])
  const title = request.from === undefined
    ? t('notesTitle').replace('{version}', request.to)
    : t('notesTitleRange').replace('{from}', request.from).replace('{to}', request.to)
  const bodyClass = 'dshMarketNotesBody' + (collapsible ? (expanded ? '' : ' dshMarketNotesCollapsed') : ' dshMarketNotesScroll')
  return (
    <section className="dshMarketNotes" aria-label={title} data-state={state.status}>
      <h3>{title}</h3>
      <div ref={body} className={bodyClass} aria-live="polite">
        {state.status === 'loading'
          ? <p className="dshMarketNotesMuted">{t('notesLoading')}</p>
          : state.status === 'failed'
            ? <p className="dshMarketNotesMuted">{t('notesUnavailable')}</p>
            : state.items.length === 0
              ? <p className="dshMarketNotesMuted">{t('notesEmpty')}</p>
              : <ol className="dshMarketNotesList">{state.items.map(note => (
                  <PluginNoteEntry key={note.version} note={note} language={language} t={t} />
                ))}</ol>}
      </div>
      {collapsible && (expanded || overflowing) && (
        <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? t('notesCollapse') : t('notesExpand')}
        </Button>
      )}
    </section>
  )
}
`

function addNotesToRenderer(settingsTab) {
  settingsTab = replaceOnce(settingsTab, "import { useCallback, useEffect, useMemo, useRef, useState } from 'react'",
    "import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'", LABEL)
  settingsTab = insertAfter(settingsTab, "import { marketMediaAssetUrl } from '../media/ref.js'\n",
    "import type { MarketPluginNote } from '../api-types.js'\nimport { readMarketPluginNotes } from './api.js'\n", LABEL)
  settingsTab = insertBefore(settingsTab, '\nfunction OperationFacts(', COMPONENT, LABEL)
  // 两个对话框都要知道界面语言：调用处把 readLocale() 交进去。
  settingsTab = insertAfter(settingsTab, '          verificationHelpHref={installRequirementsUrl(readLocale())}\n',
    '          notesLocale={readLocale()}\n', LABEL)
  settingsTab = insertAfter(settingsTab, '        <OperationConfirmModal\n          preview={operationPreview}\n',
    '          notesLocale={readLocale()}\n', LABEL)
  // 详情：在介绍下面、版本卡片上面。清单还在读时不问，免得先按最新版问一次、再按更新范围问一次。
  settingsTab = patchFunction(settingsTab, 'ItemActionModal', detail => {
    detail = replaceOnce(detail, '  onRetryInventory,\n  t,\n}: {', '  onRetryInventory,\n  notesLocale,\n  t,\n}: {', LABEL)
    detail = replaceOnce(detail, "  onRetryInventory?: (() => void) | undefined\n  t: MarketSettingsTabProps['t']",
      "  onRetryInventory?: (() => void) | undefined\n  notesLocale?: string | undefined\n  t: MarketSettingsTabProps['t']", LABEL)
    detail = replaceOnce(detail, '  const checking = preview === undefined && pending && operationError === undefined\n',
      '  const checking = preview === undefined && pending && operationError === undefined\n'
      + '  const notesRequest = inventoryLoading ? undefined : detailNotesRequest(value, installation)\n', LABEL)
    return insertAfter(detail, '              <p>{value.item.description ?? value.item.summary}</p>\n            </div>\n',
      '            {notesRequest !== undefined && <PluginNotes request={notesRequest} locale={notesLocale} collapsible t={t} />}\n', LABEL)
  })
  // 更新确认框：版本表下面列出从已装到目标之间每一版的说明，区域自己滚动；按钮不变。
  return patchFunction(settingsTab, 'OperationConfirmModal', modal => {
    modal = replaceOnce(modal, 'function OperationConfirmModal({ preview, pending, error, onCancel, onConfirm, t }: {',
      'function OperationConfirmModal({ preview, pending, error, onCancel, onConfirm, notesLocale, t }: {', LABEL)
    modal = replaceOnce(modal, "  onConfirm: () => void\n  t: MarketSettingsTabProps['t']",
      "  onConfirm: () => void\n  notesLocale?: string | undefined\n  t: MarketSettingsTabProps['t']", LABEL)
    return insertAfter(modal, '        <OperationFacts operation={preview} t={t} />\n',
      '        {updating && preview.updateFrom !== undefined && preview.version !== undefined && <PluginNotes\n'
      + '          request={{ packageName: preview.packageName, from: preview.updateFrom, to: preview.version }}\n'
      + '          locale={notesLocale}\n          t={t}\n        />}\n', LABEL)
  })
}

/** 样式：沿用市场的卡片边框、底色与文字层级，只用宿主 token，浅色与深色都跟着主题走。 */
const NOTES_STYLES = String.raw`
.dshMarketNotes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.dshMarketNotes h3 {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}

.dshMarketNotesBody {
  align-self: stretch;
  min-width: 0;
}

.dshMarketNotesCollapsed {
  max-height: 168px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
  mask-image: linear-gradient(to bottom, #000 70%, transparent);
}

.dshMarketNotesScroll {
  max-height: 240px;
  overflow-y: auto;
}

.dshMarketNotesList {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dshMarketNoteHead {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.dshMarketNoteHead strong {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}

.dshMarketNotes p,
.dshMarketNotes li {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.dshMarketNoteText {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.dshMarketNoteText ul {
  margin: 0;
  padding-left: 18px;
}

.dshMarketNoteText li.dshMarketNoteNested {
  margin-left: 16px;
}

.dshMarketNoteText strong {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

.dshMarketNoteText code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
}

.dshMarketNotes p.dshMarketNotesMuted {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
`

const MESSAGES = {
  zh: {
    notesTitle: 'v{version} 更新了什么',
    notesTitleRange: 'v{from} → v{to} 更新了什么',
    notesOtherLanguage: '（仅有英文说明）',
    notesEmpty: '这一版没有填写更新说明',
    notesUnavailable: '暂时读不到更新说明',
    notesLoading: '正在读取更新说明…',
    notesExpand: '展开全部',
    notesCollapse: '收起',
  },
  en: {
    notesTitle: "What's new in v{version}",
    notesTitleRange: "What's new from v{from} to v{to}",
    notesOtherLanguage: '(Chinese only)',
    notesEmpty: 'No release notes were written for this version.',
    notesUnavailable: 'Release notes are unavailable right now.',
    notesLoading: 'Loading release notes…',
    notesExpand: 'Show all',
    notesCollapse: 'Show less',
  },
}

/**
 * 插件更新说明：宿主路由、客户端调用、类型、详情与更新确认框里的「更新了什么」、样式与文案。
 * 须排在 market.updates（确认框的 updating 与 updateFrom）、market.docs-link（路由数组的同一处收尾）之后。
 * @param input - staging 中市场的宿主路由、客户端 API、类型、设置面板、样式与文案。
 * @param origin - 产品市场的 HTTPS origin（与插件目录同一个）。
 * @returns 改写后的六个文件内容。
 * @throws 上游锚点变化时抛出，中断打包待人工复查。
 */
export function addMarketPluginNotes(input, origin) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error(`${LABEL}: HTTPS origin required`)
  let { routes, api, types, settingsTab, styles, locales } = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.replaceAll('\r\n', '\n')]))
  if (types.includes('interface MarketPluginNote ')) throw new Error(`${LABEL}: already applied`)
  types += TYPES
  routes = addNotesRoute(routes, origin)
  api = addNotesCall(api)
  settingsTab = addNotesToRenderer(settingsTab)
  styles = insertBefore(styles, '`\n\nexport function installMarketStyles(', NOTES_STYLES, LABEL)
  for (const [language, anchor] of [['zh', "  tab: '插件市场',\n"], ['en', "  tab: 'Plugin Market',\n"]]) {
    const entries = Object.entries(MESSAGES[language]).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},\n`).join('')
    locales = insertAfter(locales, anchor, entries, LABEL)
  }
  return { routes, api, types, settingsTab, styles, locales }
}

/** 设置面板的产品回归：详情与更新确认框的请求参数、语言回退、空说明、失败不阻塞、正文不当 HTML。 */
const UI_TESTS = String.raw`
describe('product plugin release notes', () => {
  const managed = {
    kind: 'profile' as const,
    packageName: '@tokensapi/notes-card',
    version: '1.9.0',
    enabled: true,
    installed: true,
    toggleable: true,
    removable: true,
  }
  const notesItem = makeInstallableItem(firstSource, 'notes-card', 'Notes Card', managed.packageName, '1.10.0')
  const freshItem = makeInstallableItem(firstSource, 'fresh-notes', 'Fresh Notes', '@tokensapi/fresh-notes', '2.0.0')
  const notesProps = { t, readLocale: () => 'en' } as MarketSettingsTabProps
  const available = { ...managed, updateVersion: '1.10.0', updateStatus: 'available' as const }

  function browse(installations: readonly import('../src/api-types.js').MarketInstallationView[]) {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [notesItem, freshItem]))
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations })
  }

  it('shows every version from the installed one to the update in the details, newest first', async () => {
    browse([available])
    vi.mocked(readMarketPluginNotes).mockResolvedValue({ items: [
      { version: '1.10.0', publishedAt: '2026-11-05T08:00:00.000Z', zh: '中文说明', en: '- Bulk **export**\n- New ' + '\u0060timeout\u0060' + ' setting' },
      { version: '1.9.1', publishedAt: null, zh: '只有中文', en: null },
    ] })
    render(<MarketSettingsTab {...notesProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Notes Card/u }))
    const notes = await screen.findByRole('region', { name: "What's new from v1.9.0 to v1.10.0" })
    await waitFor(() => expect(notes.getAttribute('data-state')).toBe('ready'))
    expect(readMarketPluginNotes).toHaveBeenLastCalledWith({ itemId: 'notes-card', from: '1.9.0', to: '1.10.0' }, expect.any(AbortSignal))
    const entries = within(notes).getAllByRole('listitem').filter(item => item.className === 'dshMarketNote')
    expect(entries.map(entry => entry.querySelector('.dshMarketNoteHead strong')?.textContent)).toEqual(['v1.10.0', 'v1.9.1'])
    expect(within(entries[0]!).getByText('export').tagName).toBe('STRONG')
    expect(within(entries[0]!).getByText('timeout').tagName).toBe('CODE')
    expect(within(entries[0]!).queryByText(en.notesOtherLanguage)).toBeNull()
    // English interface, only a Chinese note: show it and say so.
    expect(within(entries[1]!).getByText('只有中文')).toBeTruthy()
    expect(within(entries[1]!).getByText(en.notesOtherLanguage)).toBeTruthy()
    // The update button next to it still works as before.
    expect(screen.getByRole('button', { name: en.updatePlugin + ': ' + managed.packageName }).hasAttribute('disabled')).toBe(false)
  })

  it('asks for the latest version alone when nothing is installed, and says when no note was written', async () => {
    const { zh } = await import('../src/client/locales.js')
    const translate = ((key: MarketLocaleKey) => zh[key]) as MarketSettingsTabProps['t']
    browse([])
    vi.mocked(readMarketPluginNotes).mockResolvedValue({ items: [{ version: '2.0.0', publishedAt: null, zh: null, en: null }] })
    render(<MarketSettingsTab {...notesProps} t={translate} readLocale={() => 'zh-CN'} />)
    fireEvent.click(await screen.findByRole('button', { name: /Fresh Notes/u }))
    const notes = await screen.findByRole('region', { name: 'v2.0.0 更新了什么' })
    expect(await within(notes).findByText(zh.notesEmpty)).toBeTruthy()
    expect(readMarketPluginNotes).toHaveBeenLastCalledWith({ itemId: 'fresh-notes', to: '2.0.0' }, expect.any(AbortSignal))
    expect(vi.mocked(readMarketPluginNotes).mock.calls.every(([request]) => request.from === undefined)).toBe(true)
  })

  it('falls back to the English note in a Chinese interface and marks it', async () => {
    const { zh } = await import('../src/client/locales.js')
    const translate = ((key: MarketLocaleKey) => zh[key]) as MarketSettingsTabProps['t']
    browse([{ ...managed, updateStatus: 'current' as const, updateVersion: '1.9.0' }])
    vi.mocked(readMarketPluginNotes).mockResolvedValue({ items: [{ version: '1.9.0', publishedAt: null, zh: null, en: 'English only' }] })
    render(<MarketSettingsTab {...notesProps} t={translate} readLocale={() => 'zh-CN'} />)
    fireEvent.click(await screen.findByRole('button', { name: /Notes Card/u }))
    const notes = await screen.findByRole('region', { name: 'v1.9.0 更新了什么' })
    expect(await within(notes).findByText('English only')).toBeTruthy()
    expect(within(notes).getByText(zh.notesOtherLanguage)).toBeTruthy()
    expect(readMarketPluginNotes).toHaveBeenLastCalledWith({ itemId: 'notes-card', to: '1.9.0' }, expect.any(AbortSignal))
  })

  it('folds long notes in the details and expands them on request', async () => {
    // jsdom 不排版：让说明区报出「内容 400px、折叠后 168px」，看折叠与展开的切换。
    const saved = ['scrollHeight', 'clientHeight'].map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true,
      get() { return (this as HTMLElement).classList.contains('dshMarketNotesBody') ? 400 : 0 } })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true,
      get() { return (this as HTMLElement).classList.contains('dshMarketNotesCollapsed') ? 168 : 400 } })
    try {
      browse([])
      vi.mocked(readMarketPluginNotes).mockResolvedValue({ items: [{ version: '2.0.0', publishedAt: null, zh: null, en: 'Long notes' }] })
      render(<MarketSettingsTab {...notesProps} />)
      fireEvent.click(await screen.findByRole('button', { name: /Fresh Notes/u }))
      const notes = await screen.findByRole('region', { name: "What's new in v2.0.0" })
      await within(notes).findByText('Long notes')
      const expand = await within(notes).findByRole('button', { name: en.notesExpand })
      expect(expand.getAttribute('aria-expanded')).toBe('false')
      expect(notes.querySelector('.dshMarketNotesCollapsed')).toBeTruthy()
      fireEvent.click(expand)
      expect(within(notes).getByRole('button', { name: en.notesCollapse }).getAttribute('aria-expanded')).toBe('true')
      expect(notes.querySelector('.dshMarketNotesCollapsed')).toBeNull()
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
        else Object.defineProperty(HTMLElement.prototype, name, descriptor)
      }
    }
  })

  it('renders notes as text and never as HTML', async () => {
    browse([])
    vi.mocked(readMarketPluginNotes).mockResolvedValue({ items: [{ version: '2.0.0', publishedAt: null, zh: null,
      en: '<img src=x onerror="window.__notesInjected = true"><script>window.__notesInjected = true</script> **safe**' }] })
    render(<MarketSettingsTab {...notesProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Fresh Notes/u }))
    const notes = await screen.findByRole('region', { name: "What's new in v2.0.0" })
    await waitFor(() => expect(notes.getAttribute('data-state')).toBe('ready'))
    expect(notes.querySelector('img, script')).toBeNull()
    expect(notes.textContent).toContain('<img src=x onerror=')
    expect(within(notes).getByText('safe').tagName).toBe('STRONG')
    expect((window as { __notesInjected?: boolean }).__notesInjected).toBeUndefined()
  })

  it('lists the update range in the confirmation, and a failed read never blocks the update', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({ installations: [available] })
    vi.mocked(readMarketPluginNotes).mockRejectedValue(new Error('offline'))
    vi.mocked(previewMarketOperation).mockResolvedValue({ action: 'update', previewId: 'update-token', profileName: 'default',
      packageName: managed.packageName, displayName: managed.packageName, version: '1.10.0', updateFrom: '1.9.0', expiresAt: '2099-01-01' })
    vi.mocked(executeMarketOperation).mockResolvedValue({ action: 'update', packageName: managed.packageName, version: '1.10.0', application: 'applied' })
    render(<MarketSettingsTab {...notesProps} />)
    fireEvent.click(await screen.findByRole('button', { name: en.installed }))
    fireEvent.click(await screen.findByRole('button', { name: en.updatePlugin + ': ' + managed.packageName }))
    const dialog = (await screen.findByRole('heading', { name: en.confirmUpdateTitle })).closest('[role="dialog"]') as HTMLElement
    const notes = within(dialog).getByRole('region', { name: "What's new from v1.9.0 to v1.10.0" })
    expect(await within(notes).findByText(en.notesUnavailable)).toBeTruthy()
    expect(readMarketPluginNotes).toHaveBeenCalledWith({ packageName: managed.packageName, from: '1.9.0', to: '1.10.0' }, expect.any(AbortSignal))
    const confirm = within(dialog).getByRole('button', { name: en.confirmUpdate })
    expect(confirm.hasAttribute('disabled')).toBe(false)
    fireEvent.click(confirm)
    expect(await screen.findByText(en.updateComplete)).toBeTruthy()
    expect(executeMarketOperation).toHaveBeenCalledWith('update-token', expect.any(AbortSignal))
  })
})
`

/** 上游设置面板用例：api.js 替身补上新导出，追加产品回归。须排在 market.test-docs-link 之后（锚定它加的替身行）。 */
export function addPluginNotesSettingsTests(tests) {
  tests = tests.replaceAll('\r\n', '\n')
  tests = insertAfter(tests, '  openMarketDocsLink: vi.fn(),\n', '  readMarketPluginNotes: vi.fn(),\n', 'market settings tab test')
  tests = insertAfter(tests, "import { en, type MarketLocaleKey } from '../src/client/locales.js'\n",
    "import { readMarketPluginNotes } from '../src/client/api.js'\n", 'market settings tab test')
  return tests + UI_TESTS
}

/** 宿主路由的产品回归：参数校验、上游地址与参数、只交回渲染需要的字段、读不到时 502。 */
const RUNTIME_TESTS = String.raw`
describe('product plugin notes route', () => {
  type RouteHandler = (req: EventEmitter & Record<string, any>, res: EventEmitter & Record<string, any>) => Promise<void>

  function harness() {
    const handlers = new Map<string, RouteHandler>()
    const ctx = {
      webServer: { port: 43_120, register: vi.fn((route: { path: string; handler: RouteHandler }) => { handlers.set(route.path, route.handler); return vi.fn() }) },
      reflect: { get: () => undefined },
    }
    const state: MarketStateStore = { getSources: () => [], setSources: vi.fn(async () => {}), getCatalogCache: () => undefined, setCatalogCache: vi.fn(async () => {}) }
    const dispose = registerMarketRoutes(ctx as never, state)
    async function call(query: string, method = 'GET') {
      const request = Object.assign(new EventEmitter(), {
        method, url: '__ROUTE__?' + query,
        headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' },
        socket: { remoteAddress: '127.0.0.1' },
      })
      let sent = ''
      const response = Object.assign(new EventEmitter(), {
        destroyed: false, writableEnded: false, statusCode: 0, setHeader: vi.fn(), removeHeader: vi.fn(),
        end: vi.fn((value: string) => { sent = value }),
      })
      await handlers.get('__ROUTE__')!(request, response)
      return { status: response.statusCode, body: sent ? JSON.parse(sent) : undefined }
    }
    return { call, dispose }
  }

  it('reads the range from the market and hands back only what the client renders', async () => {
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson').mockResolvedValue({ finalUrl: 'https://market.tokensapi.ai/', value: { items: [
      { version: '1.2.0', publishedAt: '2026-11-05T08:00:00.000Z', zh: '新增导出', en: null, internal: 'dropped' },
      { version: 'not-a-version', zh: 'dropped' },
      { version: '1.1.0', publishedAt: 7, zh: '', en: 'Fixes' },
    ] } })
    const { call, dispose } = harness()
    const answer = await call('itemId=tokens-connect&from=1.0.0&to=1.2.0')
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ items: [
      { version: '1.2.0', publishedAt: '2026-11-05T08:00:00.000Z', zh: '新增导出', en: null },
      { version: '1.1.0', publishedAt: null, zh: null, en: 'Fixes' },
    ] })
    const [url, , policy] = getJson.mock.calls[0]!
    expect(url).toBe('https://market.tokensapi.ai/v1/plugins/tokens-connect/notes?from=1.0.0&to=1.2.0')
    expect(policy).toEqual({ allowedOrigin: 'https://market.tokensapi.ai' })
    // Without from, only the target version is asked for.
    await call('itemId=tokens-connect&to=1.2.0')
    expect(getJson.mock.calls[1]![0]).toBe('https://market.tokensapi.ai/v1/plugins/tokens-connect/notes?to=1.2.0')
    dispose()
    getJson.mockRestore()
  })

  it('refuses bad input without asking the market and answers 502 when the market cannot be read', async () => {
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson').mockRejectedValue(new Error('offline'))
    const { call, dispose } = harness()
    expect((await call('itemId=tokens-connect')).status).toBe(400)
    expect((await call('itemId=tokens-connect&to=latest')).status).toBe(400)
    expect((await call('itemId=tokens-connect&from=1&to=1.2.0')).status).toBe(400)
    expect((await call('itemId=../admin&to=1.2.0')).status).toBe(404)
    expect((await call('to=1.2.0')).status).toBe(404)
    expect((await call('itemId=tokens-connect&to=1.2.0', 'POST')).status).toBe(405)
    expect(getJson).not.toHaveBeenCalled()
    const failed = await call('itemId=tokens-connect&to=1.2.0')
    expect(failed.status).toBe(502)
    expect(failed.body).toEqual({ error: 'plugin notes unavailable' })
    vi.mocked(getJson).mockResolvedValueOnce({ finalUrl: 'https://market.tokensapi.ai/', value: { unexpected: true } })
    expect((await call('itemId=tokens-connect&to=1.2.0')).status).toBe(502)
    dispose()
    getJson.mockRestore()
  })
})
`.replaceAll('__ROUTE__', PLUGIN_NOTES_ROUTE)

/** 上游运行时用例按个数断言宿主注册的路由；产品再多一个更新说明路由。须排在 market.test-docs-link 之后。 */
export function addPluginNotesRuntimeTests(tests) {
  tests = replaceOnce(tests.replaceAll('\r\n', '\n'), '    // 产品覆盖：多一个插件文档入口路由。\n    expect(routeDisposers).toHaveLength(5)\n',
    '    // 产品覆盖：多一个插件文档入口路由、一个插件更新说明路由。\n    expect(routeDisposers).toHaveLength(6)\n', 'market runtime test')
  return tests + RUNTIME_TESTS
}
