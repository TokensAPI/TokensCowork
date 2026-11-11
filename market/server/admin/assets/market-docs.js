import { renderMarkdown } from './market-markdown.js'

// The plugin documentation center at /docs. The reader signs in with their TokensAPI Key; it is
// kept for this browser tab only (sessionStorage) and sent as a Bearer header to /v1/docs, which
// answers with the plugins that Key may see — the same access decision as the desktop catalog.
// Addresses are #/<pluginId>/<docId>, so a page can be linked to directly.
const KEY = 'market-docs-key'
const $ = id => document.getElementById(id)
const state = { plugins: [], pages: new Map(), open: new Set(), pluginId: '', docId: 0 }

const storedKey = () => { try { return sessionStorage.getItem(KEY) ?? '' } catch { return '' } }
const storeKey = value => { try { value ? sessionStorage.setItem(KEY, value) : sessionStorage.removeItem(KEY) } catch {} }
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
const icon = path => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('chevron')
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  line.setAttribute('d', path)
  svg.append(line)
  return svg
}
const name = plugin => plugin.displayName || plugin.id
const href = (pluginId, docId) => `#/${encodeURIComponent(pluginId)}${docId ? '/' + docId : ''}`

async function read(path) {
  const response = await fetch(path, { headers: { Authorization: 'Bearer ' + storedKey() }, cache: 'no-store' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status })
  return data
}

/* ── Sidebar ─────────────────────────────────────────── */
function renderNav() {
  const keyword = $('docs-search').value.trim().toLowerCase()
  const nav = $('docs-nav')
  nav.replaceChildren()
  for (const plugin of state.plugins) {
    const docs = keyword && !name(plugin).toLowerCase().includes(keyword) && !plugin.id.includes(keyword)
      ? plugin.docs.filter(doc => doc.title.toLowerCase().includes(keyword))
      : plugin.docs
    if (keyword && !docs.length && !name(plugin).toLowerCase().includes(keyword)) continue
    const group = el('div', 'nav-group' + (state.open.has(plugin.id) || keyword ? ' open' : ''))
    const title = el('button', 'nav-plugin' + (plugin.docs.length ? '' : ' no-docs'))
    title.type = 'button'
    title.append(el('span', '', name(plugin)))
    if (plugin.docs.length) title.append(icon('m9 6 6 6-6 6'))
    else title.append(el('span', 'nav-tag', '暂无文档'))
    title.onclick = () => {
      if (!plugin.docs.length) { location.hash = href(plugin.id); return }
      state.open.has(plugin.id) ? state.open.delete(plugin.id) : state.open.add(plugin.id)
      if (state.pluginId !== plugin.id) location.hash = href(plugin.id, plugin.docs[0].id)
      else renderNav()
    }
    group.append(title)
    if (docs.length) {
      const list = el('ul', 'nav-docs')
      for (const doc of docs) {
        const link = el('a', state.pluginId === plugin.id && state.docId === doc.id ? 'active' : '', doc.title)
        link.href = href(plugin.id, doc.id)
        link.onclick = () => document.body.classList.remove('nav-open')
        const item = el('li')
        item.append(link)
        list.append(item)
      }
      group.append(list)
    }
    nav.append(group)
  }
  if (!nav.children.length) nav.append(el('p', 'nav-none', keyword ? '没有匹配的插件或文档。' : '你还没有可用的插件。'))
}

/* ── Page ────────────────────────────────────────────── */
function showEmpty(title, text) {
  $('docs-article').replaceChildren()
  $('docs-toc').replaceChildren()
  $('docs-pager').replaceChildren()
  $('docs-updated').textContent = ''
  document.querySelector('.toc').hidden = true
  $('docs-empty-title').textContent = title
  $('docs-empty-text').textContent = text
  $('docs-empty').hidden = false
}

function renderToc(article) {
  const toc = $('docs-toc')
  toc.replaceChildren()
  const headings = [...article.querySelectorAll('h2, h3')]
  headings.forEach((heading, index) => {
    heading.id = `section-${index + 1}`
    const link = el('a', '', heading.textContent)
    link.href = '#'
    link.onclick = event => { event.preventDefault(); heading.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
    const item = el('li', heading.tagName === 'H3' ? 'depth-3' : '')
    item.append(link)
    toc.append(item)
  })
  document.querySelector('.toc').hidden = headings.length === 0
}

function renderPager(plugin, index) {
  const pager = $('docs-pager')
  pager.replaceChildren()
  const link = (doc, label, className) => {
    const a = el('a', className)
    a.href = href(plugin.id, doc.id)
    a.append(el('small', '', label), el('strong', '', doc.title))
    pager.append(a)
  }
  if (index > 0) link(plugin.docs[index - 1], '上一篇', 'prev')
  if (index < plugin.docs.length - 1) link(plugin.docs[index + 1], '下一篇', 'next')
}

async function renderPage() {
  const plugin = state.plugins.find(item => item.id === state.pluginId)
  $('docs-crumb').textContent = plugin ? name(plugin) : ''
  $('docs-empty').hidden = true
  if (!plugin) return showEmpty('没有找到这个插件', '它可能已下架，或者你的 Key 没有权限查看。')
  if (!plugin.docs.length) return showEmpty('这个插件还没有文档', '管理员上传后会显示在这里。')
  let pages = state.pages.get(plugin.id)
  if (!pages) {
    try {
      pages = (await read('/v1/docs/' + encodeURIComponent(plugin.id))).items
    } catch (error) {
      if (error.status === 401) return signOut(error.message)
      return showEmpty('文档暂时打不开', error.message)
    }
    state.pages.set(plugin.id, pages)
    if (state.pluginId !== plugin.id) return
  }
  const index = Math.max(0, pages.findIndex(doc => doc.id === state.docId))
  const doc = pages[index]
  if (!doc) return showEmpty('这个插件还没有文档', '管理员上传后会显示在这里。')
  const article = $('docs-article')
  article.replaceChildren(renderMarkdown(doc.body))
  // A page without its own top heading gets its title as one.
  if (article.firstElementChild?.tagName !== 'H1') article.prepend(el('h1', '', doc.title))
  renderToc(article)
  renderPager({ ...plugin, docs: pages }, index)
  $('docs-updated').textContent = `最后更新于 ${new Date(doc.updatedAt).toLocaleString(undefined, { hour12: false })}`
  document.title = `${doc.title} · ${name(plugin)} · TokensCowork 插件文档`
  window.scrollTo({ top: 0 })
}

/* ── Routing ─────────────────────────────────────────── */
function route() {
  const [pluginId = '', docId = ''] = location.hash.replace(/^#\/?/u, '').split('/').map(part => decodeURIComponent(part))
  const fallback = state.plugins.find(plugin => plugin.docs.length) ?? state.plugins[0]
  if (!pluginId && fallback) {
    history.replaceState(null, '', href(fallback.id, fallback.docs[0]?.id))
    return route()
  }
  state.pluginId = pluginId
  const plugin = state.plugins.find(item => item.id === pluginId)
  state.docId = Number(docId) || plugin?.docs[0]?.id || 0
  if (plugin) state.open.add(plugin.id)
  renderNav()
  if (!state.plugins.length) return showEmpty('你还没有可用的插件', '有权限的插件会显示在这里。')
  void renderPage()
}

async function load() {
  const locale = navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  const data = await read('/v1/docs?locale=' + encodeURIComponent(locale))
  // Plugins with pages first, then by name.
  state.plugins = data.items.sort((a, b) => (b.docs.length > 0) - (a.docs.length > 0) || name(a).localeCompare(name(b), 'zh-CN'))
  state.pages.clear()
  document.body.classList.remove('signed-out')
  route()
}

function signOut(message = '') {
  storeKey('')
  Object.assign(state, { plugins: [], pluginId: '', docId: 0 })
  state.pages.clear()
  state.open.clear()
  document.body.classList.add('signed-out')
  document.body.classList.remove('nav-open')
  document.title = 'TokensCowork · 插件文档'
  $('docs-login-error').textContent = message
}

function setNav(open) {
  document.body.classList.toggle('nav-open', open)
  $('sidebar-backdrop').hidden = !open
  $('menu-toggle').setAttribute('aria-expanded', String(open))
}

$('docs-login').onsubmit = async event => {
  event.preventDefault()
  $('docs-login-error').textContent = ''
  storeKey($('docs-key').value.trim())
  try {
    await load()
    $('docs-key').value = ''
  } catch (error) {
    signOut(error.message)
  }
}
$('docs-logout').onclick = () => signOut()
$('docs-search').oninput = renderNav
$('menu-toggle').onclick = () => setNav(!document.body.classList.contains('nav-open'))
$('sidebar-backdrop').onclick = () => setNav(false)
window.addEventListener('hashchange', () => {
  setNav(false)
  if (!document.body.classList.contains('signed-out')) route()
})

if (storedKey()) load().catch(error => signOut(error.status === 401 ? error.message : ''))
