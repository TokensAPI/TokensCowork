import { spawnSync } from 'node:child_process'

const MAC_RELEASE_SECRETS = [
  'APPLE_CERT_BASE64',
  'APPLE_CERT_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_PASSWORD',
  'APPLE_TEAM_ID',
]

/** Select formal Developer ID release signing only when the complete credential set exists. */
export function selectMacSigningMode(environment) {
  const present = MAC_RELEASE_SECRETS.filter(name => environment[name]?.trim())
  if (present.length === 0) return 'adhoc'
  if (present.length === MAC_RELEASE_SECRETS.length) return 'signed'

  const missing = MAC_RELEASE_SECRETS.filter(name => !present.includes(name))
  throw new Error(`Incomplete macOS release credentials: missing ${missing.join(', ')}`)
}

/** Read the public certificate subject without exporting or logging the private key. */
export function adaptAppleReleaseEnvironment(environment, run = spawnSync) {
  if (selectMacSigningMode(environment) !== 'signed') {
    throw new Error('Signed macOS release requires all five APPLE_ secrets')
  }
  const encoded = environment.APPLE_CERT_BASE64.replaceAll(/\s/g, '')
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(encoded)) {
    throw new Error('APPLE_CERT_BASE64 must be a Base64-encoded PKCS#12 file')
  }
  const readOptions = {
    input: Buffer.from(encoded, 'base64'),
    encoding: 'utf8',
    env: { ...environment },
  }
  const readArgs = ['pkcs12', '-clcerts', '-nokeys', '-passin', 'env:APPLE_CERT_PASSWORD']
  let certificate = run('openssl', readArgs, readOptions)
  // OpenSSL 3 needs its legacy provider for some Keychain-exported PKCS#12 files.
  if (!certificate.error && certificate.status !== 0) certificate = run('openssl', [...readArgs, '-legacy'], readOptions)
  if (certificate.error || certificate.status !== 0) {
    throw new Error('Cannot read APPLE_CERT_BASE64: check the PKCS#12 file and APPLE_CERT_PASSWORD')
  }
  const subject = run('openssl', ['x509', '-noout', '-subject', '-nameopt', 'sep_multiline,utf8'], {
    input: certificate.stdout,
    encoding: 'utf8',
    env: { ...environment },
  })
  if (subject.error || subject.status !== 0) throw new Error('Cannot read the macOS signing certificate subject')
  const identities = [...subject.stdout.matchAll(/^\s*CN\s*=\s*(Developer ID Application:[^\r\n]+)\s*$/gm)]
  if (identities.length !== 1) throw new Error('APPLE_CERT_BASE64 must supply a Developer ID Application certificate')
  const identity = identities[0][1].trim()
  if (!identity.endsWith(`(${environment.APPLE_TEAM_ID.trim()})`)) {
    throw new Error('The signing certificate does not match APPLE_TEAM_ID')
  }
  const adapted = {
    ...environment,
    MAC_CERT_P12_BASE64: encoded,
    CSC_KEY_PASSWORD: environment.APPLE_CERT_PASSWORD,
    MACOS_SIGN_IDENTITY: identity,
    APPLE_APP_SPECIFIC_PASSWORD: environment.APPLE_APP_PASSWORD,
  }
  for (const name of ['APPLE_CERT_BASE64', 'APPLE_CERT_PASSWORD', 'APPLE_APP_PASSWORD']) delete adapted[name]
  // Only the supplied certificate may select the signing identity.
  for (const name of ['CSC_LINK', 'CSC_NAME', 'CSC_IDENTITY_AUTO_DISCOVERY']) delete adapted[name]
  return adapted
}

if (process.argv[1] === import.meta.filename) {
  try {
    process.stdout.write(`${selectMacSigningMode(process.env)}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
