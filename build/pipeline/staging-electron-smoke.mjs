// Disposable Electron launch probe. Never use an installed app's profile.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { productStage } from './paths.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const desktop = resolve(productStage(root), 'dsh-plugin-desktop')
const executable = resolve(desktop, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
assert.ok(existsSync(executable), 'Electron executable is missing')
const sandbox = mkdtempSync(resolve(root, '.build', 'electron-smoke-'))
const appData = resolve(sandbox, 'AppData')
const userHome = resolve(sandbox, 'home')
const productName = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8')).product.name
mkdirSync(appData, { recursive: true })
mkdirSync(userHome, { recursive: true })
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/TOKEN|SECRET|API_?KEY|ELECTRON_RUN_AS_NODE/iu.test(key)))
Object.assign(env, {
  APPDATA: appData, TOKENS_COWORK_DEV_APP_DATA: appData,
  USERPROFILE: userHome, HOME: userHome, DSH_HOME: resolve(userHome, '.dsh'),
  DSH_TELEMETRY_DISABLED: '1',
})
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const child = spawn(executable, [desktop, '--enable-logging=stderr', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
  cwd: sandbox, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function checkHostErrors() {
  const directory = resolve(appData, productName, 'logs', 'host')
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.error.log')) continue
    const errors = readFileSync(resolve(directory, entry), 'utf8').split(/\r?\n/u).filter(line => line.includes('[E]'))
    assert.equal(errors.length, 0, `Host plugin failed: ${errors.join('\n')}`)
  }
}
let socket
try {
  let target
  let lastTargets = []
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}: ${output.slice(-5000)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      const targets = await response.json()
      const snapshot = targets.map(({ type, url }) => ({ type, url: url.split('?')[0] }))
      if (JSON.stringify(snapshot) !== JSON.stringify(lastTargets)) {
        lastTargets = snapshot
        console.log(`Electron pages: ${JSON.stringify(lastTargets)}`)
      }
      target = targets.find(item => item.type === 'page' && /^https?:\/\/127\.0\.0\.1:/u.test(item.url))
      if (target) break
    } catch {}
    await pause(1000)
  }
  assert.ok(target, `No app renderer reached localhost: ${JSON.stringify(lastTargets)} ${output.slice(-5000)}`)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let nextId = 0
  const pending = new Map()
  const exceptions = []
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      exceptions.push(detail.exception?.description ?? detail.text)
    }
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 60000)
    pending.set(id, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  let page
  const rendererDeadline = Date.now() + 90_000
  do {
    await pause(1000)
    checkHostErrors()
    const result = await send('Runtime.evaluate', {
      expression: '({title:document.title,ready:document.readyState,text:document.body.innerText,inputs:document.querySelectorAll("input,textarea,[contenteditable=true]").length})',
      returnByValue: true,
    })
    page = result.result.value
    if (page.ready === 'complete' && page.inputs > 0 && !/Loading plugins|Checking sign-in status/iu.test(page.text)) break
  } while (Date.now() < rendererDeadline)
  writeFileSync(resolve(sandbox, 'renderer.json'), JSON.stringify({ ...page, exceptions }, null, 2))
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(sandbox, 'renderer.png'), Buffer.from(screenshot.data, 'base64'))
  assert.equal(page.ready, 'complete')
  assert.ok(page.text.length > 20, 'Renderer is blank')
  assert.ok(page.inputs > 0, 'Renderer never exposed a usable input')
  assert.ok(!/Loading plugins|Checking sign-in status/iu.test(page.text), 'Renderer remained on startup/loading screen')
  assert.equal(exceptions.length, 0, `Renderer exceptions: ${exceptions.join(', ')}`)
  checkHostErrors()
  const lifecyclePath = resolve(appData, productName, 'lifecycle-events/startup.jsonl')
  const healthDeadline = Date.now() + 30000
  let healthy = false
  do {
    const events = existsSync(lifecyclePath)
      ? readFileSync(lifecyclePath, 'utf8').trim().split(/\r?\n/u).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] } // writer may be appending the last line
      }) : []
    healthy = events.some(event => event.eventName === 'startup.run.completed' && event.details?.rendererStatus === 'healthy')
    if (!healthy) await pause(500)
  } while (!healthy && Date.now() < healthDeadline)
  assert.ok(healthy, 'Desktop did not commit a healthy startup')
  checkHostErrors()
  console.log(JSON.stringify({ status: 'healthy-startup', title: page.title, inputs: page.inputs, sandbox }))
} finally {
  socket?.close()
  // Only the process created by this probe is stopped; never kill by image name.
  if (process.platform === 'win32' && child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else child.kill()
  await Promise.race([exited, pause(5000)])
  writeFileSync(resolve(sandbox, 'electron.log'), output)
  console.log(`Electron probe artifacts: ${sandbox}`)
}
