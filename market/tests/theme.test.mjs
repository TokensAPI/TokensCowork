import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../admin/assets/market-theme.js', import.meta.url), 'utf8')
function fixture(saved, dark = false, blocked = false) {
  const events = {}, system = { matches: dark, addEventListener: (_, fn) => { events.system = fn } }
  const control = { value: '', addEventListener: (_, fn) => { events.choice = fn } }
  const document = { documentElement: { dataset: {} }, getElementById: () => control, addEventListener: (_, fn) => { events.ready = fn } }
  const storage = { value: saved }
  vm.runInNewContext(source, { document,
    window: { matchMedia: () => system, addEventListener: (_, fn) => { events.storage = fn } },
    localStorage: { getItem: () => { if (blocked) throw Error('blocked'); return storage.value }, setItem: (_, value) => { if (blocked) throw Error('blocked'); storage.value = value } },
  })
  events.ready()
  return { document, events, control, storage, system, theme: () => document.documentElement.dataset.theme }
}
test('theme follows system by default and responds to system changes', () => {
  const f = fixture(null, true)
  assert.equal(f.theme(), 'dark')
  assert.equal(f.control.value, 'system')
  f.system.matches = false; f.events.system()
  assert.equal(f.theme(), 'light')
})
test('explicit choice persists on reload and overrides system', () => {
  const f = fixture(null)
  f.events.choice({ target: { value: 'dark' } })
  assert.equal(f.theme(), 'dark')
  assert.equal(fixture(f.storage.value).theme(), 'dark')
  f.events.system(); assert.equal(f.theme(), 'dark')
})
test('theme works when browser storage is blocked', () => {
  const f = fixture(null, false, true)
  f.events.choice({ target: { value: 'dark' } })
  assert.equal(f.theme(), 'dark')
})
test('theme synchronizes across tabs and ignores invalid saved values', () => {
  const f = fixture('invalid')
  assert.equal(f.control.value, 'system')
  f.events.storage({ key: 'tokenscowork-market-theme', newValue: 'dark' })
  assert.equal(f.theme(), 'dark')
  f.events.storage({ key: null, newValue: null })
  assert.equal(f.theme(), 'light')
})
