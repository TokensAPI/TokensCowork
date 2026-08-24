import assert from 'node:assert/strict'
import test from 'node:test'

import { selectMacSigningMode } from './signing-mode.mjs'

const complete = {
  MAC_CERT_P12_BASE64: 'certificate',
  CSC_KEY_PASSWORD: 'password',
  MACOS_SIGN_IDENTITY: 'Developer ID Application: Example (TEAM)',
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
  APPLE_TEAM_ID: 'TEAM',
}

test('selects ad-hoc signing when no release credentials exist', () => {
  assert.equal(selectMacSigningMode({}), 'adhoc')
})

test('selects formal signing for the complete credential set', () => {
  assert.equal(selectMacSigningMode(complete), 'signed')
})

test('rejects a partial credential set', () => {
  assert.throws(
    () => selectMacSigningMode({ ...complete, APPLE_TEAM_ID: '' }),
    /missing APPLE_TEAM_ID/,
  )
})
