import { renderMarkdown } from './market-markdown.js'

// The plugin documentation center. The reader signs in with their TokensAPI Key; it is kept for
// this browser tab only (sessionStorage) and sent as a Bearer header to /v1/docs, which answers
// with the plugins that Key may see — the same access decision as the desktop catalog.
const KEY = 'market-docs-key'
const $ = id => document.getElementById(id)
const state = { plugins: [], selected: null, docs: [], page: 0 }

function storedKey() {
  try { return sessionStorage.getItem(KEY) ?? '' } catch { return '' }
}
function storeKey(value) {
  try { value ? sessionStorage.setItem(KEY, value) : sessionStorage.removeItem(KEY) } catch {}
}

async function read(path) {
  const response = await fetch(path, { headers: { Authorization: 'Bearer ' + storedKey() }, cache: 'no-store' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status })
  return data
}

function signedIn(value) {
  document.body.classList.toggle('docs-signed-out', !value)
}

function renderPlugins() {
  const keyword = $('docs-search').value.trim().toLowerCase()
  const list = $('docs-plugin-list')
  list.replaceChildren()
  for (const plugin of state.plugins) {
    if (keyword && !`${plugin.displayName} ${plugin.id}`.toLowerCase().includes(keyword)) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'docs-plugin' + (plugin.id === state.selected?.id ? ' active' : '')
    const name = document.createElement('strong')
    name.textContent = plugin.displayName || plugin.id
    const count = document.createElement('small')
    count.textContent = plugin.docs.length ? `${plugin.docs.length} 篇文档` : '暂无文档'
    button.append(name, count)
    button.onclick = () => { void selectPlugin(plugin) }
    const item = document.createElement('li')
    item.append(button)
    list.append(item)
  }
}

function renderPage() {
  const tabs = $('docs-tabs')
  tabs.replaceChildren()
  state.docs.forEach((doc, index) => {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.role = 'tab'
    tab.className = 'docs-tab' + (index === state.page ? ' active' : '')
    tab.setAttribute('aria-selected', String(index === state.page))
    tab.textContent = doc.title
    tab.onclick = () => { state.page = index; renderPage() }
    tabs.append(tab)
  })
  tabs.hidden = state.docs.length < 2
  const doc = state.docs[state.page]
  $('docs-article').replaceChildren(doc ? renderMarkdown(doc.body) : '')
  $('docs-empty').textContent = state.selected && !doc ? '这个插件还没有文档。' : ''
}

async function selectPlugin(plugin) {
  state.selected = plugin
  state.docs = []
  state.page = 0
  $('docs-plugin-title').textContent = plugin.displayName || plugin.id
  renderPlugins()
  renderPage()
  if (!plugin.docs.length) return
  try {
    state.docs = (await read('/v1/docs/' + encodeURIComponent(plugin.id))).items
  } catch (error) {
    if (error.status === 401) return signOut(error.message)
    $('docs-empty').textContent = error.message
    return
  }
  if (state.selected === plugin) renderPage()
}

async function load() {
  const locale = navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  const data = await read('/v1/docs?locale=' + encodeURIComponent(locale))
  state.plugins = data.items
  signedIn(true)
  renderPlugins()
  const first = state.plugins.find(plugin => plugin.docs.length) ?? state.plugins[0]
  if (first) await selectPlugin(first)
  else $('docs-empty').textContent = '你还没有可用的插件。'
}

function signOut(message = '') {
  storeKey('')
  Object.assign(state, { plugins: [], selected: null, docs: [], page: 0 })
  signedIn(false)
  $('docs-login-error').textContent = message
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
$('docs-search').oninput = renderPlugins

if (storedKey()) load().catch(error => signOut(error.status === 401 ? error.message : ''))
