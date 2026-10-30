import assert from 'node:assert/strict'
import test from 'node:test'
import { disableUpstreamSessionLogSetting } from './session-log-overlay.mjs'

test('disables the upstream session-log settings row by id', () => {
  const patched = disableUpstreamSessionLogSetting('- id: system-prompt')
  assert.match(patched, /\n- id: ui-settings-session-log\n {2}disabled: true$/u)
  assert.ok(patched.startsWith('- id: system-prompt\n'))
})

test('refuses a patch layer that already mentions the upstream row', () => {
  assert.throws(() => disableUpstreamSessionLogSetting('- id: ui-settings-session-log\n  disabled: true'),
    /ui-settings-session-log/u)
})
