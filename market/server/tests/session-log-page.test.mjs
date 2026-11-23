import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sessionRoute, parseSessionRoute } from '../admin/assets/market-session-log-format.js'
import { lockControls, latestOnly } from '../admin/assets/market-ui.js'

// The session-log page's address, and how it runs operations without locking the page
// (market-ui.js lockControls / latestOnly, used through action({ lock }) in market-admin.js).

test('a session has its own address, and anything malformed falls back to the list', () => {
  assert.equal(sessionRoute('session-1111-2222', 4), 'session-logs/session-1111-2222/4')
  assert.deepEqual(parseSessionRoute('#' + sessionRoute('session-a.b_c', 4)), { id: 'session-a.b_c', formatVersion: 4 })
  assert.deepEqual(parseSessionRoute('session-logs/session-x/12'), { id: 'session-x', formatVersion: 12 })
  for (const hash of ['', '#session-logs', '#session-logs/', '#session-logs/session-x', '#session-logs/session-x/v4', '#session-logs/session-x/4/more',
    '#session-logs/bad%20id/4', '#session-logs/%E0%A4%A/4', '#plugins/session-x/4', '#session-logs/' + 'a'.repeat(129) + '/4'])
    assert.equal(parseSessionRoute(hash), null, hash)
})

// Just enough of an element for lockControls: a control, or a container of controls.
function element(tag, { disabled = false, children = [] } = {}) {
  const classes = new Set(), attributes = new Map()
  return {
    tag, disabled, dataset: {}, children,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name), getAttribute: name => attributes.get(name) ?? null,
    matches: selector => selector.split(',').includes(tag),
    querySelectorAll: () => children,
  }
}

test('a read locks nothing; a change locks only its own button or dialog, once', () => {
  const save = element('button'), other = element('button'), filter = element('select')
  const page = [save, other, filter]
  const snapshot = () => page.map(el => [el.disabled, el.classList.contains('btn-loading')])
  // A read: nothing on the page changes while it runs.
  const releaseRead = lockControls([])
  assert.equal(typeof releaseRead, 'function')
  assert.deepEqual(snapshot(), [[false, false], [false, false], [false, false]])
  releaseRead()
  // A change from one button: only that button, drawn as loading; a second click is refused.
  const release = lockControls(save)
  assert.deepEqual(snapshot(), [[true, true], [false, false], [false, false]])
  assert.equal(save.getAttribute('aria-busy'), 'true')
  assert.equal(lockControls(save), null)
  release()
  assert.deepEqual(snapshot(), [[false, false], [false, false], [false, false]])
  assert.equal(save.getAttribute('aria-busy'), null)
  // A dialog: every control inside it, and each goes back the way it was -- including one that
  // was already disabled.
  const field = element('input'), submit = element('button'), off = element('button', { disabled: true })
  const dialog = element('form', { children: [field, submit, off] })
  const releaseDialog = lockControls(dialog)
  assert.deepEqual([field.disabled, submit.disabled, off.disabled, other.disabled], [true, true, true, false])
  releaseDialog()
  assert.deepEqual([field.disabled, submit.disabled, off.disabled], [false, false, true])
})

test('only the latest of overlapping reads is shown', async () => {
  const turns = latestOnly()
  const shown = []
  const load = async (name, delay) => {
    const turn = turns.next()
    await new Promise(resolve => setTimeout(resolve, delay))
    if (turns.current(turn)) shown.push(name)
  }
  // Page 2 is asked for, then page 3; page 2's slower answer arrives last and is dropped.
  await Promise.all([load('page 2', 30), load('page 3', 5)])
  assert.deepEqual(shown, ['page 3'])
})

// Every operation the session-log page starts names what it locks, so none of them falls back to
// the console-wide lock; every other page keeps calling action() without it.
function actionCalls(source) {
  const calls = []
  for (let at = source.indexOf('action('); at !== -1; at = source.indexOf('action(', at + 1)) {
    if (/[\w.]/u.test(source[at - 1] ?? '')) continue
    let depth = 0, end = at + 'action'.length
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++
      else if (source[end] === ')' && --depth === 0) break
    }
    calls.push(source.slice(at, end + 1))
  }
  return calls
}
test('the session-log page never locks the whole console; other pages are unchanged', () => {
  const read = file => readFileSync(new URL(`../admin/assets/${file}`, import.meta.url), 'utf8')
  for (const file of ['market-session-logs.js', 'market-session-log-detail.js']) {
    const calls = actionCalls(read(file))
    assert.ok(calls.length > 0, file)
    for (const call of calls) assert.match(call, /\block\b/u, `${file}: ${call.slice(0, 80)}`)
  }
  for (const file of ['market-organizations.js', 'market-keys.js', 'market-users.js', 'market-plugins.js'])
    for (const call of actionCalls(read(file))) assert.doesNotMatch(call, /\block:/u, `${file}: ${call.slice(0, 80)}`)
  // The console-wide lock is still the default.
  const admin = read('market-admin.js')
  assert.match(admin, /if \(lock !== undefined\) return lockedAction\(/u)
  assert.match(admin, /document\.querySelectorAll\('button,input,textarea,select'\)/u)
})
