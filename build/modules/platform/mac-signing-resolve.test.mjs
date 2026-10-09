import assert from 'node:assert/strict'
import test from 'node:test'

import { adaptAppleReleaseEnvironment, selectMacSigningMode } from './mac-signing-resolve.mjs'

const complete = {
  APPLE_CERT_BASE64: 'MA==',
  APPLE_CERT_PASSWORD: 'password',
  APPLE_ID: 'release@example.com',
  APPLE_APP_PASSWORD: 'app-password',
  APPLE_TEAM_ID: 'TEAM',
}

test('selects ad-hoc signing when no release credentials exist', () => {
  assert.equal(selectMacSigningMode({}), 'adhoc')
})

const subjectRunner = subject => (command, args, options) => {
  assert.equal(command, 'openssl')
  assert.ok(!args.includes(complete.APPLE_CERT_PASSWORD))
  assert.ok(options.input)
  return { status: 0, stdout: args[0] === 'pkcs12' ? 'public certificate' : subject }
}

test('derives identity and adapts the five secrets without changing the caller', () => {
  const env = adaptAppleReleaseEnvironment(complete, subjectRunner('subject=\n    CN=Developer ID Application: Example (TEAM)\n'))
  assert.equal(env.MACOS_SIGN_IDENTITY, 'Developer ID Application: Example (TEAM)')
  assert.equal(env.CSC_KEY_PASSWORD, complete.APPLE_CERT_PASSWORD)
  assert.equal(env.APPLE_APP_SPECIFIC_PASSWORD, complete.APPLE_APP_PASSWORD)
  assert.equal(env.MAC_CERT_P12_BASE64, complete.APPLE_CERT_BASE64)
  assert.equal(env.APPLE_CERT_PASSWORD, undefined)
  assert.equal(complete.APPLE_CERT_PASSWORD, 'password')
})

test('rejects wrong certificate type and team', () => {
  assert.throws(() => adaptAppleReleaseEnvironment(complete, subjectRunner('CN=Apple Development: Example (TEAM)')), /Developer ID Application/)
  assert.throws(() => adaptAppleReleaseEnvironment(complete, subjectRunner('CN=Developer ID Application: Example (OTHER)')), /does not match APPLE_TEAM_ID/)
})

test('certificate read failures do not expose command stderr or the password', () => {
  assert.throws(() => adaptAppleReleaseEnvironment(complete, () => ({ status: 1, stderr: 'secret-value' })), error => {
    assert.ok(!error.message.includes('secret-value'))
    return /Cannot read APPLE_CERT_BASE64/.test(error.message)
  })
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
