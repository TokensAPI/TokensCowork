import { renderMarkdown } from './market-markdown.js'

// The plugin documentation center at /docs. The reader signs in with their TokensAPI Key, kept for
// this tab (sessionStorage) or, when they ask to be remembered, on this computer (localStorage),
// and sent as a Bearer header to /v1/docs, which answers with the plugins that Key may see — the
// same access decision as the desktop catalog. Addresses: #/ is the overview, #/<plugin>/<doc>
// a page, and #/<plugin>/<doc>/<section> a heading on it, so any of them can be linked to.
const KEY = 'market-docs-key'
const $ = id => document.getElementById(id)
const state = { plugins: [], pages: new Map(), open: new Set(), pluginId: '', docId: 0, section: '', othersOpen: false }
const search = { results: [], active: 0, loading: null }
let spy = null

/* ── Helpers ─────────────────────────────────────────── */
function storedKey() {
  try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || '' } catch { return '' }
}
function storeKey(value, remember) {
  try {
    localStorage.removeItem(KEY)
    sessionStorage.removeItem(KEY)
    if (value) (remember ? localStorage : sessionStorage).setItem(KEY, value)
  } catch {}
}
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
const SVG = 'http://www.w3.org/2000/svg'
function icon(paths, className = '') {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  if (className) svg.setAttribute('class', className)
  for (const d of [].concat(paths)) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}
const ICONS = {
  chevron: 'm9 6 6 6-6 6',
  home: ['M4 11 12 4l8 7', 'M6 10v10h12V10'],
  doc: ['M6 3h9l4 4v14H6z', 'M14 3v5h5'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  check: 'm5 12 5 5L20 7',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  note: ['M12 8h.01', 'M11 12h1v5h1', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  tip: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z'],
  important: ['M12 7v6', 'M12 16h.01', 'M4 4h16v13H8l-4 4z'],
  warning: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  caution: ['M12 8v4', 'M12 16h.01', 'M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z'],
}
const name = plugin => plugin.displayName || plugin.id
const href = (pluginId, docId, section) => `#/${encodeURIComponent(pluginId)}${docId ? '/' + docId : ''}${section ? '/' + section : ''}`
const withDocs = () => state.plugins.filter(plugin => plugin.docs.length)
const withoutDocs = () => state.plugins.filter(plugin => !plugin.docs.length)
const mac = /Mac|iPhone|iPad/u.test(navigator.platform)

// A plugin's tile: its first character on a colour picked from its id, so it stays the same.
function tile(plugin, className = 'tile') {
  let hash = 0
  for (const char of plugin.id) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  const node = el('span', className, [...name(plugin)][0]?.toUpperCase() ?? '?')
  node.style.setProperty('--tile-hue', String(hash % 360))
  node.setAttribute('aria-hidden', 'true')
  return node
}

let toastTimer
function toast(message) {
  const node = $('toast')
  node.textContent = message
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.hidden = true }, 1800)
}
async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message) } catch { toast('复制失败，请手动选择复制') }
}

async function read(path) {
  const response = await fetch(path, { headers: { Authorization: 'Bearer ' + storedKey() }, cache: 'no-store' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status })
  return data
}
async function pagesOf(plugin) {
  if (!state.pages.has(plugin.id)) state.pages.set(plugin.id, (await read('/v1/docs/' + encodeURIComponent(plugin.id))).items)
  return state.pages.get(plugin.id)
}

/* ── Sidebar ─────────────────────────────────────────── */
function navPlugin(plugin) {
  const group = el('div', 'nav-group' + (state.open.has(plugin.id) ? ' open' : ''))
  const title = el('button', 'nav-plugin' + (state.pluginId === plugin.id ? ' current' : ''))
  title.type = 'button'
  title.append(el('span', '', name(plugin)), icon(ICONS.chevron, 'chevron'))
  title.onclick = () => {
    state.open.has(plugin.id) ? state.open.delete(plugin.id) : state.open.add(plugin.id)
    if (state.pluginId !== plugin.id) location.hash = href(plugin.id, plugin.docs[0].id)
    else renderNav()
  }
  const list = el('ul', 'nav-docs')
  for (const doc of plugin.docs) {
    const link = el('a', state.pluginId === plugin.id && state.docId === doc.id ? 'active' : '', doc.title)
    link.href = href(plugin.id, doc.id)
    const item = el('li')
    item.append(link)
    list.append(item)
  }
  group.append(title, list)
  return group
}

function renderNav() {
  const nav = $('docs-nav')
  nav.replaceChildren()
  const home = el('a', 'nav-home' + (state.pluginId ? '' : ' active'))
  home.href = '#/'
  home.append(icon(ICONS.home), el('span', '', '总览'))
  nav.append(home, el('p', 'nav-label', '插件'))
  const documented = withDocs()
  for (const plugin of documented) nav.append(navPlugin(plugin))
  if (!documented.length) nav.append(el('p', 'nav-none', '还没有插件文档。'))
  // Plugins without pages stay out of the way, folded at the bottom.
  const rest = withoutDocs()
  if (rest.length) {
    const group = el('div', 'nav-others' + (state.othersOpen ? ' open' : ''))
    const toggle = el('button', 'nav-others-toggle')
    toggle.type = 'button'
    toggle.append(el('span', '', `暂无文档（${rest.length}）`), icon(ICONS.chevron, 'chevron'))
    toggle.onclick = () => { state.othersOpen = !state.othersOpen; renderNav() }
    const list = el('ul', 'nav-others-list')
    for (const plugin of rest) {
      const link = el('a', state.pluginId === plugin.id ? 'active' : '', name(plugin))
      link.href = href(plugin.id)
      const item = el('li')
      item.append(link)
      list.append(item)
    }
    group.append(toggle, list)
    nav.append(group)
  }
}

/* ── Overview ────────────────────────────────────────── */
function renderHome() {
  $('docs-home').hidden = false
  $('docs-page').hidden = true
  $('docs-doc').classList.add('is-home')
  $('docs-toc-panel').hidden = true
  spy?.disconnect()
  const cards = $('docs-cards')
  cards.replaceChildren()
  for (const plugin of withDocs()) {
    const card = el('a', 'card')
    card.href = href(plugin.id, plugin.docs[0].id)
    const head = el('div', 'card-head')
    head.append(tile(plugin), el('strong', '', name(plugin)))
    const foot = el('div', 'card-foot')
    foot.append(el('span', '', `${plugin.docs.length} 篇文档`), icon(ICONS.arrow, 'card-arrow'))
    card.append(head, el('p', 'card-summary', plugin.summary || '查看使用说明'), foot)
    cards.append(card)
  }
  if (!cards.children.length) {
    const empty = el('div', 'empty')
    empty.append(icon(ICONS.doc), el('h2', '', '还没有插件文档'), el('p', '', '管理员上传后会显示在这里。'))
    cards.append(empty)
  }
  const rest = withoutDocs().length
  $('docs-home-more').textContent = rest ? `另有 ${rest} 个你可以使用的插件暂无文档。` : ''
  document.title = 'TokensCowork · 插件文档'
}

/* ── Page ────────────────────────────────────────────── */
function showEmpty(title, text) {
  $('docs-article').replaceChildren()
  $('docs-pager').replaceChildren()
  $('docs-updated').textContent = ''
  $('docs-toc-panel').hidden = true
  $('docs-empty-title').textContent = title
  $('docs-empty-text').textContent = text
  $('docs-empty').hidden = false
}

const CALLOUTS = { NOTE: '说明', TIP: '提示', IMPORTANT: '重要', WARNING: '注意', CAUTION: '警告' }
// GitHub's alert syntax: a quote whose first line is [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION].
function upgradeCallouts(article) {
  for (const quote of article.querySelectorAll('blockquote')) {
    const first = quote.firstElementChild
    const text = first?.firstChild
    const match = text?.nodeType === Node.TEXT_NODE ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/iu.exec(text.textContent) : null
    if (!match) continue
    const kind = match[1].toUpperCase()
    text.textContent = text.textContent.slice(match[0].length)
    // Drop what the marker line leaves behind: empty text and the line break after it.
    while (first.firstChild && (first.firstChild.nodeName === 'BR' || (first.firstChild.nodeType === Node.TEXT_NODE && !first.firstChild.textContent.trim()))) first.firstChild.remove()
    if (!first.textContent.trim() && !first.children.length) first.remove()
    quote.classList.add('callout', `callout-${kind.toLowerCase()}`)
    const title = el('p', 'callout-title')
    title.append(icon(ICONS[kind.toLowerCase()]), el('span', '', CALLOUTS[kind]))
    quote.prepend(title)
  }
}

const CJK = /[⺀-鿿豈-﫿＀-￯]/u
// Markdown treats a single line break inside a paragraph as a soft break: a space between words,
// nothing between two CJK characters. The shared renderer keeps every line break, which wraps
// source files written with short lines into a narrow column.
function softenLineBreaks(article) {
  for (const br of [...article.querySelectorAll('br')]) {
    if (br.closest('pre')) continue
    const before = br.previousSibling?.textContent?.slice(-1) ?? ''
    const after = br.nextSibling?.textContent?.charAt(0) ?? ''
    br.replaceWith(CJK.test(before) && CJK.test(after) ? '' : ' ')
  }
  article.normalize()
}

function upgradeCode(article) {
  for (const pre of article.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    const language = /language-([\w+-]+)/u.exec(code?.className ?? '')?.[1] ?? ''
    const block = el('div', 'code-block')
    const head = el('div', 'code-head')
    const button = el('button', 'code-copy')
    button.type = 'button'
    button.setAttribute('aria-label', '复制代码')
    button.append(icon(ICONS.copy), el('span', '', '复制'))
    button.onclick = () => { void copy(code?.textContent ?? pre.textContent, '代码已复制') }
    head.append(el('span', 'code-lang', language || 'text'), button)
    pre.replaceWith(block)
    block.append(head, pre)
  }
}

function upgradeHeadings(article, plugin, doc) {
  const headings = [...article.querySelectorAll('h2, h3')]
  headings.forEach((heading, index) => {
    heading.id = `section-${index + 1}`
    heading.dataset.label = heading.textContent
    const anchor = el('a', 'anchor', '#')
    anchor.href = href(plugin.id, doc.id, heading.id)
    anchor.setAttribute('aria-label', `复制「${heading.textContent}」的链接`)
    anchor.onclick = event => {
      event.preventDefault()
      history.replaceState(null, '', anchor.getAttribute('href'))
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
      void copy(location.href, '本节链接已复制')
    }
    heading.append(anchor)
  })
  return headings
}

function renderToc(headings) {
  const toc = $('docs-toc')
  toc.replaceChildren()
  const links = new Map()
  for (const heading of headings) {
    const link = el('a', '', heading.dataset.label)
    link.href = heading.querySelector('.anchor').getAttribute('href')
    link.onclick = event => {
      event.preventDefault()
      history.replaceState(null, '', link.getAttribute('href'))
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const item = el('li', heading.tagName === 'H3' ? 'depth-3' : '')
    item.append(link)
    toc.append(item)
    links.set(heading, link)
  }
  $('docs-toc-panel').hidden = headings.length === 0
  // Scroll spy: the current section is the last heading that has scrolled past the top bar.
  spy?.disconnect()
  if (!headings.length) return
  let frame = 0
  const update = () => {
    frame = 0
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
    const current = atBottom ? headings.at(-1)
      : [...headings].reverse().find(heading => heading.getBoundingClientRect().top <= 110) ?? headings[0]
    for (const [heading, link] of links) link.classList.toggle('active', heading === current)
  }
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
  window.addEventListener('scroll', onScroll, { passive: true })
  spy = { disconnect: () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) } }
  update()
}

function renderPager(plugin, pages, index) {
  const pager = $('docs-pager')
  pager.replaceChildren()
  const link = (doc, label, className) => {
    const a = el('a', className)
    a.href = href(plugin.id, doc.id)
    a.append(el('small', '', label), el('strong', '', doc.title))
    pager.append(a)
  }
  if (index > 0) link(pages[index - 1], '上一篇', 'prev')
  if (index < pages.length - 1) link(pages[index + 1], '下一篇', 'next')
}

async function renderPage() {
  $('docs-home').hidden = true
  $('docs-page').hidden = false
  $('docs-doc').classList.remove('is-home')
  $('docs-empty').hidden = true
  spy?.disconnect()
  const plugin = state.plugins.find(item => item.id === state.pluginId)
  $('docs-crumb').textContent = plugin ? name(plugin) : ''
  if (!plugin) return showEmpty('没有找到这个插件', '它可能已下架，或者你的 Key 没有权限查看。')
  if (!plugin.docs.length) return showEmpty('这个插件还没有文档', '管理员上传后会显示在这里。')
  let pages
  try {
    pages = await pagesOf(plugin)
  } catch (error) {
    if (error.status === 401) return signOut(error.message)
    return showEmpty('文档暂时打不开', error.message)
  }
  if (state.pluginId !== plugin.id) return
  const index = Math.max(0, pages.findIndex(doc => doc.id === state.docId))
  const doc = pages[index]
  if (!doc) return showEmpty('这个插件还没有文档', '管理员上传后会显示在这里。')
  const article = $('docs-article')
  article.replaceChildren(renderMarkdown(doc.body))
  // A page without its own top heading gets its title as one.
  if (article.firstElementChild?.tagName !== 'H1') article.prepend(el('h1', '', doc.title))
  upgradeCallouts(article)
  softenLineBreaks(article)
  upgradeCode(article)
  renderToc(upgradeHeadings(article, plugin, doc))
  renderPager(plugin, pages, index)
  $('docs-updated').textContent = `最后更新于 ${new Date(doc.updatedAt).toLocaleString(undefined, { hour12: false })}`
  document.title = `${doc.title} · ${name(plugin)} · TokensCowork 插件文档`
  const target = state.section && $(state.section)
  if (target) target.scrollIntoView({ block: 'start' })
  else window.scrollTo({ top: 0 })
}

/* ── Routing ─────────────────────────────────────────── */
function route() {
  const [pluginId = '', docId = '', section = ''] = location.hash.replace(/^#\/?/u, '').split('/').map(part => decodeURIComponent(part))
  state.pluginId = pluginId
  const plugin = state.plugins.find(item => item.id === pluginId)
  state.docId = Number(docId) || plugin?.docs[0]?.id || 0
  state.section = /^section-\d+$/u.test(section) ? section : ''
  if (plugin?.docs.length) state.open.add(plugin.id)
  renderNav()
  if (!pluginId) return renderHome()
  void renderPage()
}

async function load() {
  const locale = navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  const data = await read('/v1/docs?locale=' + encodeURIComponent(locale))
  state.plugins = data.items.sort((a, b) => name(a).localeCompare(name(b), 'zh-CN'))
  state.pages.clear()
  search.loading = null
  document.body.classList.remove('signed-out')
  route()
}

function signOut(message = '') {
  storeKey('')
  Object.assign(state, { plugins: [], pluginId: '', docId: 0, section: '' })
  state.pages.clear()
  state.open.clear()
  spy?.disconnect()
  closeSearch()
  document.body.classList.add('signed-out')
  setNav(false)
  document.title = 'TokensCowork · 插件文档'
  $('docs-login-error').textContent = message
}

function setNav(open) {
  document.body.classList.toggle('nav-open', open)
  $('sidebar-backdrop').hidden = !open
  $('menu-toggle').setAttribute('aria-expanded', String(open))
}

/* ── Search (Ctrl/⌘ K) ───────────────────────────────── */
// Titles are searchable at once; page bodies are fetched the first time the search opens.
function loadAllPages() {
  search.loading ??= Promise.allSettled(withDocs().map(pagesOf))
  return search.loading
}
const plain = body => body
  .replace(/```[^\n]*\n/gu, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
  .replace(/(^|\n)\s*(?:[-*+]|\d+\.)\s+/gu, '$1')
  .replace(/[#>*_`|~]+|-{2,}/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()

function runSearch() {
  const query = $('search-input').value.trim().toLowerCase()
  const results = []
  for (const plugin of withDocs()) {
    const pluginHit = name(plugin).toLowerCase().includes(query) || plugin.id.includes(query)
    const pages = state.pages.get(plugin.id)
    for (const doc of pages ?? plugin.docs) {
      const title = doc.title.toLowerCase()
      const text = pages ? plain(doc.body) : ''
      const at = query ? text.toLowerCase().indexOf(query) : -1
      let score = !query ? 1 : title.includes(query) ? 3 : pluginHit ? 2 : at >= 0 ? 1 : 0
      if (!score) continue
      const snippet = at >= 0 ? text.slice(Math.max(0, at - 28), at + query.length + 48) : (text.slice(0, 80) || plugin.summary || '')
      results.push({ plugin, doc, score, snippet, prefixed: at > 28 })
    }
  }
  results.sort((a, b) => b.score - a.score)
  search.results = results.slice(0, 30)
  search.active = 0
  renderResults(query)
}

function highlight(text, query) {
  const fragment = document.createDocumentFragment()
  if (!query) { fragment.append(text); return fragment }
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, from)) {
    fragment.append(text.slice(from, at), el('mark', '', text.slice(at, at + query.length)))
    from = at + query.length
  }
  fragment.append(text.slice(from))
  return fragment
}

function renderResults(query) {
  const list = $('search-results')
  list.replaceChildren()
  search.results.forEach((result, index) => {
    const item = el('li', 'search-result' + (index === search.active ? ' active' : ''))
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(index === search.active))
    const title = el('div', 'search-result-title')
    title.append(highlight(result.doc.title, query))
    const meta = el('div', 'search-result-meta')
    meta.append(tile(result.plugin, 'tile tile-sm'), el('span', '', name(result.plugin)))
    const snippet = el('div', 'search-result-snippet')
    snippet.append(highlight((result.prefixed ? '…' : '') + result.snippet, query))
    item.append(title, meta, snippet)
    item.onmouseenter = () => { search.active = index; markActive() }
    item.onclick = () => openResult(result)
    list.append(item)
  })
  const loading = search.loading && !state.pages.size
  $('search-hint').textContent = search.results.length ? ''
    : withDocs().length ? (loading ? '正在载入文档内容…' : `没有找到「${query}」相关的文档。`) : '还没有插件文档。'
}

function markActive() {
  ;[...$('search-results').children].forEach((item, index) => {
    item.classList.toggle('active', index === search.active)
    item.setAttribute('aria-selected', String(index === search.active))
    if (index === search.active) item.scrollIntoView({ block: 'nearest' })
  })
}

function openResult(result) {
  closeSearch()
  location.hash = href(result.plugin.id, result.doc.id)
}

function openSearch() {
  if (document.body.classList.contains('signed-out')) return
  $('search-dialog').hidden = false
  document.body.classList.add('search-open')
  $('search-input').value = ''
  runSearch()
  $('search-input').focus()
  void loadAllPages().then(() => { if (!$('search-dialog').hidden) runSearch() })
}
function closeSearch() {
  $('search-dialog').hidden = true
  document.body.classList.remove('search-open')
}

$('search-open').onclick = openSearch
$('search-backdrop').onclick = closeSearch
$('search-input').oninput = runSearch
$('search-input').onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!search.results.length) return
    search.active = (search.active + (event.key === 'ArrowDown' ? 1 : -1) + search.results.length) % search.results.length
    markActive()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const result = search.results[search.active]
    if (result) openResult(result)
  }
}
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    $('search-dialog').hidden ? openSearch() : closeSearch()
  } else if (event.key === 'Escape' && !$('search-dialog').hidden) {
    closeSearch()
  } else if (event.key === '/' && $('search-dialog').hidden && !/^(INPUT|TEXTAREA|SELECT)$/u.test(document.activeElement?.tagName ?? '')) {
    event.preventDefault()
    openSearch()
  }
})
for (const id of ['search-shortcut', 'home-shortcut']) $(id).textContent = mac ? '⌘ K' : 'Ctrl K'

/* ── Sign-in and navigation ──────────────────────────── */
$('docs-login').onsubmit = async event => {
  event.preventDefault()
  $('docs-login-error').textContent = ''
  storeKey($('docs-key').value.trim(), $('docs-remember').checked)
  try {
    await load()
    $('docs-key').value = ''
  } catch (error) {
    signOut(error.message)
  }
}
$('docs-logout').onclick = () => signOut()
$('menu-toggle').onclick = () => setNav(!document.body.classList.contains('nav-open'))
$('sidebar-backdrop').onclick = () => setNav(false)
window.addEventListener('hashchange', () => {
  setNav(false)
  if (!document.body.classList.contains('signed-out')) route()
})

if (storedKey()) load().catch(error => signOut(error.status === 401 ? error.message : ''))
