/**
 * Screenshots of every console page, for looking at a layout before anyone else does.
 *
 * Starts the local QA server (ops/market-dev.mjs --offline: fictional fixtures, network blocked,
 * memory only) on a free loopback port, adds one fictional documentation page with an image,
 * then drives the Edge or Chrome already installed here, headless, over the DevTools protocol
 * (Node's own WebSocket; no npm dependency). It signs in as the platform administrator and
 * captures each page light, dark and narrow (400 px). Nothing outside this machine is contacted
 * and nothing in the repository is written: the pictures go to a temporary folder, printed at
 * the end. The browser and the server it started are stopped by their process ids.
 *
 * The new console (/admin/next/, built from admin-web/ into admin/next/) is captured beside the
 * old one: `next-<page>` next to `<page>`, and `-menu` / `-dialog` with a row's 「更多」 menu or the
 * page's add dialog open. The local server sends the console's real security headers, so every
 * page is also checked for Content-Security-Policy violations; any one fails the run.
 *
 * Usage: node ops/market-screenshots.mjs [--out <folder>] [--only keys,next-keys]
 * Browser: MARKET_SCREENSHOT_BROWSER, else Edge, else Chrome at their usual Windows paths.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { DEMO_PARENT } from './session-log-demo.mjs'

const root = resolve(import.meta.dirname, '..')
const argument = name => { const at = process.argv.indexOf(name); return at === -1 ? '' : process.argv[at + 1] ?? '' }
const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').replace('T', '-')
const out = resolve(argument('--out') || join(tmpdir(), `market-screenshots-${stamp}`))
const only = new Set(argument('--only').split(',').filter(Boolean))
const TOKEN = 'screenshots-' + randomBytes(12).toString('hex')
const sleep = ms => new Promise(done => setTimeout(done, ms))

const VARIANTS = [
  { name: 'light', width: 1440, height: 900, scheme: 'light', mobile: false },
  { name: 'dark', width: 1440, height: 900, scheme: 'dark', mobile: false },
  { name: 'narrow', width: 400, height: 860, scheme: 'light', mobile: true },
]
// Each page, and what has to be on screen before it counts as drawn.
const consoleReady = page => `!document.body.classList.contains('session-pending') && !document.getElementById('workspace').hidden
  && !document.querySelector('[data-panel="${page}"]').hidden`
const keysReady = `${consoleReady('keys')} && document.querySelectorAll('#key-list tr').length > 0`
// The new console is drawn once its page title is the page's and its list has rows.
const nextReady = title => `document.querySelector('main .page-title')?.textContent === ${JSON.stringify(title)} && document.querySelectorAll('main tbody tr').length > 0`
const openMenu = rows => `document.querySelector(${JSON.stringify(`${rows} button[aria-label$="更多操作"]`)}).click()`
// Clicks the visible button that reads `text` (the same words in both consoles).
const clickText = text => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && b.offsetParent).click()`
const clickFirst = selector => `document.querySelector(${JSON.stringify(selector)}).click()`
const nextDetailReady = `document.querySelectorAll('main .log-turn').length > 0`
const openGrants = rows => `document.querySelector(${JSON.stringify(`${rows} button[aria-label$="授权插件"]`)}).click()`
function pages(origin, docs) {
  return [
    { name: 'plugins', url: `${origin}/admin/#plugins`, ready: `${consoleReady('plugins')} && document.querySelectorAll('#plugins-panel tbody tr, #plugins-panel .card .card-body').length > 0` },
    { name: 'next-plugins', url: `${origin}/admin/next/#plugins`, ready: nextReady('插件') },
    { name: 'plugins-access', url: `${origin}/admin/#plugins`, ready: `${consoleReady('plugins')} && document.querySelectorAll('#plugins-panel tbody tr, #plugins-panel .card .card-body').length > 0`, action: clickFirst('#plugin-rows button[aria-label$=" 访问范围"]') },
    { name: 'next-plugins-access', url: `${origin}/admin/next/#plugins`, ready: nextReady('插件'), action: clickFirst('main tbody button[aria-label$=" 访问范围"]') },
    { name: 'plugins-catalog', url: `${origin}/admin/#plugins`, ready: `${consoleReady('plugins')} && document.querySelectorAll('#plugins-panel tbody tr, #plugins-panel .card .card-body').length > 0`, action: clickFirst('#plugin-rows button[aria-label$=" 编辑资料"]') },
    { name: 'next-plugins-catalog', url: `${origin}/admin/next/#plugins`, ready: nextReady('插件'), action: clickFirst('main tbody button[aria-label$=" 编辑资料"]') },
    { name: 'plugins-icon', url: `${origin}/admin/#plugins`, ready: `${consoleReady('plugins')} && document.querySelectorAll('#plugins-panel tbody tr, #plugins-panel .card .card-body').length > 0`, action: clickFirst('#plugin-rows button[aria-label$=" 图标"]') },
    { name: 'next-plugins-icon', url: `${origin}/admin/next/#plugins`, ready: nextReady('插件'), action: clickFirst('main tbody button[aria-label$=" 图标"]') },
    { name: 'plugins-lifecycle', url: `${origin}/admin/#plugins`, ready: `${consoleReady('plugins')} && document.querySelectorAll('#plugins-panel tbody tr, #plugins-panel .card .card-body').length > 0`, action: clickFirst('#plugin-rows button[aria-label$=" 下架"]') },
    { name: 'next-plugins-lifecycle', url: `${origin}/admin/next/#plugins`, ready: nextReady('插件'), action: clickFirst('main tbody button[aria-label$=" 下架"]') },
    { name: 'organizations', url: `${origin}/admin/#organizations`, ready: `${consoleReady('organizations')} && document.querySelectorAll('#organization-list tr').length > 0` },
    { name: 'keys', url: `${origin}/admin/#keys`, ready: keysReady },
    { name: 'keys-menu', url: `${origin}/admin/#keys`, ready: keysReady, action: openMenu('#key-list tr') },
    { name: 'keys-dialog', url: `${origin}/admin/#keys`, ready: keysReady, action: `document.getElementById('new-key').click()` },
    { name: 'keys-grants', url: `${origin}/admin/#keys`, ready: keysReady, action: openGrants('#key-list tr') },
    // The new console's Key page, drawn the same way.
    { name: 'next-keys', url: `${origin}/admin/next/#keys`, ready: nextReady('Key') },
    { name: 'next-keys-menu', url: `${origin}/admin/next/#keys`, ready: nextReady('Key'), action: openMenu('main tbody tr') },
    { name: 'next-keys-dialog', url: `${origin}/admin/next/#keys`, ready: nextReady('Key'), action: `document.querySelector('.page-header .btn-primary').click()` },
    { name: 'next-keys-grants', url: `${origin}/admin/next/#keys`, ready: nextReady('Key'), action: openGrants('main tbody tr') },
    { name: 'next-legacy', url: `${origin}/admin/next/#plugins`, ready: `document.querySelector('main .empty-title')?.textContent.includes('插件')` },
    { name: 'users', url: `${origin}/admin/#users`, ready: `${consoleReady('users')} && document.querySelectorAll('#user-list tr').length > 0` },
    { name: 'next-users', url: `${origin}/admin/next/#users`, ready: nextReady('用户') },
    { name: 'organizations-detail', url: `${origin}/admin/#organizations`, ready: `${consoleReady('organizations')} && document.querySelectorAll('#organization-list tr').length > 0`, action: clickFirst('#organization-list tr button[aria-label$="查看插件"]') },
    { name: 'next-organizations', url: `${origin}/admin/next/#organizations`, ready: nextReady('组织') },
    { name: 'next-organizations-detail', url: `${origin}/admin/next/#organizations`, ready: nextReady('组织'), action: clickFirst('main tbody tr button[aria-label$="查看插件"]') },
    { name: 'activity', url: `${origin}/admin/#activity`, ready: `${consoleReady('activity')} && document.querySelectorAll('#activity-list tr').length > 0` },
    { name: 'next-activity', url: `${origin}/admin/next/#activity`, ready: nextReady('操作记录') },
    { name: 'docs', url: `${origin}/admin/#docs`, ready: `${consoleReady('docs')} && document.querySelectorAll('#docs-list tr').length > 0` },
    { name: 'session-logs', url: `${origin}/admin/#session-logs`, ready: `${consoleReady('session-logs')} && document.querySelectorAll('#session-log-list tr').length > 0` },
    { name: 'session-logs-menu', url: `${origin}/admin/#session-logs`, ready: `${consoleReady('session-logs')} && document.querySelectorAll('#session-log-list tr').length > 0`, action: openMenu('#session-log-list tr') },
    { name: 'session-log-detail', url: `${origin}/admin/#session-logs/${DEMO_PARENT}/4`,
      ready: `${consoleReady('session-logs')} && !document.getElementById('session-log-detail').hidden && document.getElementById('session-log-turns').children.length > 0` },
    { name: 'session-log-detail-open', url: `${origin}/admin/#session-logs/${DEMO_PARENT}/4`,
      ready: `${consoleReady('session-logs')} && !document.getElementById('session-log-detail').hidden && document.getElementById('session-log-turns').children.length > 0`, action: clickText('全部展开') },
    { name: 'session-log-raw', url: `${origin}/admin/#session-logs/${DEMO_PARENT}/4`,
      ready: `${consoleReady('session-logs')} && !document.getElementById('session-log-detail').hidden && document.getElementById('session-log-turns').children.length > 0`, action: clickText('原始 JSON') },
    { name: 'next-session-logs', url: `${origin}/admin/next/#session-logs`, ready: nextReady('会话日志') },
    { name: 'next-session-logs-menu', url: `${origin}/admin/next/#session-logs`, ready: nextReady('会话日志'), action: openMenu('main tbody tr') },
    { name: 'next-session-log-detail', url: `${origin}/admin/next/#session-logs/${DEMO_PARENT}/4`, ready: nextDetailReady },
    { name: 'next-session-log-detail-open', url: `${origin}/admin/next/#session-logs/${DEMO_PARENT}/4`, ready: nextDetailReady, action: clickText('全部展开') },
    { name: 'next-session-log-raw', url: `${origin}/admin/next/#session-logs/${DEMO_PARENT}/4`, ready: nextDetailReady, action: clickText('原始 JSON') },
    { name: 'docs-center', url: `${origin}/docs?admin#/${encodeURIComponent(docs.pluginId)}/${docs.docId}`,
      ready: `document.getElementById('docs-article')?.children.length > 0 && !document.querySelector('#docs-article img.md-image:not([src])')` },
  ].filter(page => !only.size || only.has(page.name))
}

/* ── A tiny PNG, so the sample documentation page has a real image to show ── */
function samplePng(width = 640, height = 220) {
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set([30 + (x * 160) / width, 110 + (y * 80) / height, 200 - (x * 90) / width].map(Math.round), 1 + x * 3)
    rows.push(row)
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

/* ── The local QA server ─────────────────────────────── */
async function startServer() {
  const child = spawn(process.execPath, ['ops/market-dev.mjs', '--offline'], {
    cwd: root, env: { ...process.env, MARKET_DEV_PORT: '0', MARKET_DEV_ADMIN_TOKEN: TOKEN, MARKET_DEV_DATA_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  const origin = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('the local QA server did not start:\n' + output)), 30000)
    const read = chunk => {
      output += chunk
      const found = /Local market QA ready: (http:\/\/127\.0\.0\.1:\d+)\/admin\//u.exec(output)
      if (found) { clearTimeout(timer); done(found[1]) }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`the local QA server exited (${code}):\n${output}`)) })
  })
  return { child, origin }
}
async function seedDocs(origin) {
  const api = (path, init = {}) => fetch(origin + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } })
  const { items } = await (await api('/api/v1/plugins?view=index')).json()
  const plugin = items.find(item => item.category !== 'builtin' && item.state === 'published')
  if (!plugin) throw new Error('no published fixture plugin to document')
  // Two fictional users in the user directory (the fixture's TokensAPI knows them), so the users
  // page has rows to draw.
  for (const [id, name] of [[6001, '测试用户甲'], [6002, '测试用户乙']])
    await api(`/api/v1/users/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
  const image = await (await api(`/api/v1/plugins/${plugin.id}/docs/images?name=sample.png`, { method: 'POST', body: samplePng(),
    headers: { 'content-type': 'application/octet-stream' } })).json()
  const body = ['# 快速开始（示例文档）', '', '这是截图脚本写进本地测试环境的虚构文档，用来看文档中心的版式。', '',
    '## 安装', '', '1. 在插件市场找到插件。', '2. 点击「安装」，等待完成。', '', '> [!NOTE]', '> 安装后需要重启一次。', '',
    `![示例截图](${image.url})`, '', '## 配置', '', '| 选项 | 说明 |', '| --- | --- |', '| 地址 | 服务地址 |', '| 密钥 | 你的 Key |', '',
    '```bash', 'npm run dev', '```'].join('\n')
  const doc = await (await api(`/api/v1/plugins/${plugin.id}/docs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '快速开始', body }) })).json()
  return { pluginId: plugin.id, docId: doc.id }
}

/* ── The browser, over the DevTools protocol ─────────── */
function browserPath() {
  const candidates = [process.env.MARKET_SCREENSHOT_BROWSER, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean)
  const found = candidates.find(path => existsSync(path))
  if (!found) throw new Error('no Edge or Chrome found; set MARKET_SCREENSHOT_BROWSER')
  return found
}
async function startBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'market-screenshots-profile-'))
  const child = spawn(browserPath(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100)
  if (!existsSync(portFile)) throw Object.assign(new Error('the browser did not open its DevTools port'), { child, profile })
  const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/u)
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('DevTools connection failed')) })
  let next = 0
  const waiting = new Map(), listeners = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id && waiting.has(message.id)) {
      const { done, fail } = waiting.get(message.id)
      waiting.delete(message.id)
      message.error ? fail(new Error(`${message.error.message}`)) : done(message.result)
    } else if (message.method) for (const listener of listeners) listener(message)
  }
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
    const id = ++next
    waiting.set(id, { done, fail })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { child, profile, socket, send, on: listener => listeners.push(listener) }
}

async function openTab(browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => browser.send(method, params, sessionId)
  await send('Page.enable')
  await send('Runtime.enable')
  // Every page records what its Content-Security-Policy refused (DevTools' own script is exempt).
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(
      event.violatedDirective + ' ' + (event.blockedURI || 'inline') + (event.sourceFile ? ' at ' + event.sourceFile + ':' + event.lineNumber : '')), true)` })
  const exceptions = []
  browser.on(message => {
    if (message.sessionId === sessionId && message.method === 'Runtime.exceptionThrown')
      exceptions.push(message.params.exceptionDetails.exception?.description?.split('\n')[0] || message.params.exceptionDetails.text)
  })
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
  async function visit(url, ready, action) {
    await send('Page.navigate', { url: 'about:blank' })
    exceptions.length = 0
    await send('Page.navigate', { url })
    const deadline = Date.now() + 15000
    let drawn = false
    while (Date.now() < deadline) {
      try { if (await evaluate(`Boolean(document.readyState === 'complete' && (${ready}))`)) { drawn = true; break } } catch {}
      await sleep(150)
    }
    // The names, organizations and images that arrive after the page has drawn.
    await sleep(700)
    if (drawn && action) {
      await evaluate(action)
      await sleep(500)
    }
    const violations = (await evaluate('window.__cspViolations')) ?? []
    return { drawn, problems: [...violations.map(text => 'CSP refused ' + text), ...exceptions.map(text => 'uncaught ' + text)] }
  }
  return { send, evaluate, visit }
}

// The whole page: the window is made as tall as the content (so fixed and full-height parts such
// as the sidebar are laid out as they would be in a tall window), captured, and put back.
async function capture(tab, file, variant) {
  const metrics = { width: variant.width, deviceScaleFactor: 1, mobile: variant.mobile }
  const { cssContentSize } = await tab.send('Page.getLayoutMetrics')
  const height = Math.min(Math.max(variant.height, Math.ceil(cssContentSize.height)), 6000)
  await tab.send('Emulation.setDeviceMetricsOverride', { ...metrics, height })
  await sleep(250)
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' })
  await tab.send('Emulation.setDeviceMetricsOverride', { ...metrics, height: variant.height })
  writeFileSync(file, Buffer.from(data, 'base64'))
}

async function stopBrowser(browser) {
  if (!browser) return
  try { await Promise.race([browser.send('Browser.close'), sleep(3000)]) } catch {}
  for (let i = 0; i < 30 && browser.child.exitCode === null; i++) await sleep(100)
  // Only the process this script started, by its id, with whatever it started under it.
  if (browser.child.exitCode === null && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browser.child.pid), '/T', '/F'], { stdio: 'ignore' })
  else if (browser.child.exitCode === null) browser.child.kill('SIGKILL')
  for (let i = 0; i < 20; i++) { try { rmSync(browser.profile, { recursive: true, force: true }); break } catch { await sleep(250) } }
}
async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return
  // A clean stop first, so the server removes its temporary folders; then by process id.
  try { server.child.send('shutdown') } catch {}
  for (let i = 0; i < 50 && server.child.exitCode === null; i++) await sleep(100)
  if (server.child.exitCode === null) server.child.kill()
  for (let i = 0; i < 30 && server.child.exitCode === null; i++) await sleep(100)
  if (server.child.exitCode === null && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.child.pid), '/T', '/F'], { stdio: 'ignore' })
}

let server, browser
const shots = []

if ((!only.size || [...only].some(name => name.startsWith('next-'))) && !existsSync(join(root, 'admin/next/index.html')))
  throw new Error('The new console is not built: run `npm --prefix admin-web ci --ignore-scripts && npm --prefix admin-web run build` in market/server first.')
try {
  mkdirSync(out, { recursive: true })
  server = await startServer()
  const docs = await seedDocs(server.origin)
  browser = await startBrowser()
  const tab = await openTab(browser)
  // Sign in once: the console session is a cookie this browser keeps for every page after.
  await tab.visit(`${server.origin}/admin/`, `document.body && !document.body.classList.contains('session-pending')`)
  const status = await tab.evaluate(`fetch('/api/v1/session', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: ${JSON.stringify(TOKEN)} }) }).then(response => response.status)`)
  if (status !== 200) throw new Error(`console sign-in failed (${status})`)
  for (const variant of VARIANTS) {
    await tab.send('Emulation.setDeviceMetricsOverride', { width: variant.width, height: variant.height, deviceScaleFactor: 1, mobile: variant.mobile })
    await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: variant.scheme }] })
    for (const page of pages(server.origin, docs)) {
      const { drawn, problems } = await tab.visit(page.url, page.ready, page.action)
      const file = join(out, `${page.name}-${variant.name}.png`)
      await capture(tab, file, variant)
      shots.push({ file, drawn, problems })
      if (!drawn) process.stderr.write(`warning: ${page.name} (${variant.name}) did not finish drawing within 15 s; captured as it was\n`)
      for (const problem of problems) process.stderr.write(`error: ${page.name} (${variant.name}): ${problem}\n`)
    }
  }
} finally {
  await stopBrowser(browser)
  await stopServer(server)
}
process.stdout.write(`Screenshots (${shots.length}) in ${out}\n${shots.map(shot => '  ' + shot.file.slice(out.length + 1)
  + (shot.drawn ? '' : '  (not fully drawn)') + (shot.problems.length ? `  (${shot.problems.length} CSP/script errors)` : '')).join('\n')}\n`)
const failed = shots.filter(shot => shot.problems.length).length
process.stdout.write(failed ? `${failed} page(s) hit CSP violations or uncaught errors; see above.\n` : 'No CSP violations or uncaught errors on any page.\n')
if (failed) process.exitCode = 1
