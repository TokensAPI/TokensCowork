const MAC_RELEASE_SECRETS = [
  'MAC_CERT_P12_BASE64',
  'CSC_KEY_PASSWORD',
  'MACOS_SIGN_IDENTITY',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
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

if (process.argv[1] === import.meta.filename) {
  try {
    process.stdout.write(`${selectMacSigningMode(process.env)}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
