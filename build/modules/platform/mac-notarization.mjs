// Electron Builder afterSign hook and recovery CLI; preserve the exact signed payload.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

export function runMac(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600000, ...options })
  // Never include argv/stderr: notarytool authentication arguments contain secrets.
  if (result.error || result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? 'timeout'})`)
  return result.stdout
}

export function queryNotary(args, run = runMac, env = process.env) {
  const password = env.APPLE_APP_PASSWORD ?? env.APPLE_APP_SPECIFIC_PASSWORD
  if (!env.APPLE_ID || !password || !env.APPLE_TEAM_ID) throw new Error('Missing Apple notarization credentials')
  const output = run('xcrun', ['notarytool', ...args, '--apple-id', env.APPLE_ID, '--password', password, '--team-id', env.APPLE_TEAM_ID, '--output-format', 'json'])
  try { return JSON.parse(output) }
  catch { throw new Error('Apple returned invalid notarization JSON') }
}

export async function waitForAcceptance(id, { query = queryNotary, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), minutes = 20 } = {}) {
  if (!uuid.test(id) || !Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error('Invalid notarization wait configuration')
  const deadline = now() + minutes * 60000
  for (;;) {
    const status = query(['info', id]).status
    console.log(`Apple notarization ${id}: ${status}`)
    if (status === 'Accepted') return
    if (status !== 'In Progress') throw new Error(`Apple notarization ${id}: ${status}; inspect the notarization log`)
    if (now() >= deadline) throw new Error(`Apple notarization ${id} is still processing; resume the saved submission instead of rebuilding`)
    await sleep(30000)
  }
}

export function validateRecoveryState(state, expected, archive) {
  for (const key of ['version', 'commit', 'arch', 'appId', 'productName']) {
    if (state[key] !== expected[key]) throw new Error(`Recovery artifact ${key} does not match source build`)
  }
  if (!['arm64', 'x64'].includes(state.arch) || !/^[a-f0-9]{40}$/i.test(state.commit)
    || !uuid.test(state.submissionId ?? '') || sha256(archive) !== state.sha256) throw new Error('Invalid or modified notarization recovery artifact')
}

export function validateSourceRun(run, repository, jobs) {
  if (run.status !== 'completed' || run.head_repository?.full_name !== repository
    || run.path !== '.github/workflows/release.yml' || !['push', 'workflow_dispatch'].includes(run.event)
    || !/^[a-f0-9]{40}$/i.test(run.head_sha)
    || !jobs.some(job => job.name === 'Resolve VERSION' && job.conclusion === 'success')) {
    throw new Error('Recovery requires a completed Build Desktop run from this repository with successful metadata')
  }
  return run.head_sha
}

export function inspectSource(runId, selection, env = process.env, run = runMac) {
  if (!/^\d+$/.test(runId) || !['arm64', 'amd64', 'both'].includes(selection)) throw new Error('Invalid source run or architecture')
  const repository = env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository')
  const api = path => JSON.parse(run('gh', ['api', `repos/${repository}/${path}`]))
  const original = api(`actions/runs/${runId}`)
  const jobs = api(`actions/runs/${runId}/attempts/${original.run_attempt}/jobs?per_page=100`).jobs
  const commit = validateSourceRun(original, repository, jobs)
  const manifest = api(`contents/product.json?ref=${commit}`)
  const version = JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8')).product.version
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid source version')
  const targets = [
    { arch: 'arm64', electron_arch: 'arm64', runner: 'macos-14' },
    { arch: 'amd64', electron_arch: 'x64', runner: 'macos-15-intel' },
  ].filter(target => selection === 'both' || target.arch === selection)
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`).artifacts
  for (const target of targets) {
    const matches = artifacts.filter(artifact => artifact.name === `mac-notarization-${target.arch}-${version}` && !artifact.expired)
    if (matches.length !== 1) throw new Error(`Expected one saved signed payload for ${target.arch}; no automatic rebuild or resubmit`)
  }
  appendFileSync(env.GITHUB_OUTPUT, `commit=${commit}\nversion=${version}\nmatrix=${JSON.stringify({ include: targets })}\n`)
}

export function verifySignedApp(app, state, notarized = false, run = runMac) {
  const contents = join(app, 'Contents')
  const plist = join(contents, 'Info.plist')
  for (const [key, expected] of [['CFBundleShortVersionString', state.version], ['CFBundleIdentifier', state.appId]]) {
    if (run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim() !== expected) throw new Error(`Signed application ${key} mismatch`)
  }
  const arch = state.arch === 'x64' ? 'x86_64' : 'arm64'
  if (run('lipo', ['-archs', join(contents, 'MacOS', state.productName)]).trim() !== arch) throw new Error('Signed application must contain exactly its target architecture')
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  // A valid ad-hoc signature must never be treated as a Developer ID release.
  run('codesign', ['--verify', '-R=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', app])
  if (notarized) {
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
    run('xcrun', ['stapler', 'validate', app])
  }
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin' || !process.env.APPLE_ID) return
  const arch = process.env.DSH_MAC_ARCH
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Explicit native macOS architecture is required')
  const root = process.env.TOKENS_MAC_RECOVERY_DIR
  if (!root) throw new Error('Notarization recovery directory is required')
  const appInfo = context.packager.appInfo
  const app = join(context.appOutDir, `${appInfo.productFilename}.app`)
  const state = { version: appInfo.version, productName: appInfo.productFilename, appId: appInfo.id, arch,
    commit: process.env.GITHUB_SHA ?? runMac('git', ['rev-parse', 'HEAD']).trim() }
  verifySignedApp(app, state)
  mkdirSync(root, { recursive: true })
  const archive = join(root, 'signed-app.zip')
  const stateFile = join(root, 'notarization.json')
  if (existsSync(archive) || existsSync(stateFile)) throw new Error('Existing notarization payload: resume it or explicitly use a fresh recovery directory')
  runMac('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
  state.sha256 = sha256(archive)
  // Persist before submitting. A missing ID on recovery is rejected, never resubmitted.
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  const submission = queryNotary(['submit', archive])
  if (!uuid.test(submission.id ?? '')) throw new Error('Apple did not return a valid submission ID')
  state.submissionId = submission.id
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  console.log(`Saved signed application and Apple submission ${state.submissionId}`)
  await waitForAcceptance(state.submissionId)
  runMac('xcrun', ['stapler', 'staple', app])
  verifySignedApp(app, state, true)
}

export async function recover(root, manifestFile, commit, arch, { run = runMac, wait = waitForAcceptance, verify = verifySignedApp, link = symlinkSync } = {}) {
  const product = JSON.parse(readFileSync(manifestFile, 'utf8')).product
  if (!/^[\w .-]+$/.test(product.name)) throw new Error('Unsupported recovery product name')
  const state = JSON.parse(readFileSync(join(root, 'notarization.json'), 'utf8'))
  const archive = join(root, 'signed-app.zip')
  validateRecoveryState(state, { version: product.version, commit, arch, productName: product.name, appId: product.appId }, archive)
  await wait(state.submissionId)
  const output = join(root, 'restored')
  if (existsSync(output)) throw new Error('Recovery output exists; use a fresh artifact download directory')
  mkdirSync(output)
  run('ditto', ['-x', '-k', archive, output])
  const app = join(output, `${product.name}.app`)
  verify(app, state, false, run)
  run('xcrun', ['stapler', 'staple', app])
  verify(app, state, true, run)
  link('/Applications', join(output, 'Applications'))
  const distributionArch = arch === 'x64' ? 'amd64' : arch
  const name = `${product.name}-${state.version}-macos-${distributionArch}`
  const dmg = join(root, `${name}-installer.dmg`)
  run('hdiutil', ['create', '-volname', product.name, '-srcfolder', output, '-format', 'UDZO', dmg])
  run('hdiutil', ['verify', dmg])
  const mount = join(root, 'mount')
  mkdirSync(mount)
  run('hdiutil', ['attach', dmg, '-mountpoint', mount, '-nobrowse', '-readonly'])
  try { verify(join(mount, `${product.name}.app`), state, true, run) }
  finally { run('hdiutil', ['detach', mount]) }
  writeFileSync(join(root, `${name}-SHA256SUMS.txt`), `${sha256(dmg)}  ${name}-installer.dmg\n`)
  writeFileSync(join(root, `${name}-BUILD-INFO.txt`), `version=${state.version}\ngit_sha=${commit}\nplatform=darwin\narchitecture=${distributionArch}\nsigning=developer-id-notarized\nsubmission_id=${state.submissionId}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'source' && process.argv.length === 5) inspectSource(process.argv[3], process.argv[4])
    else if (process.argv[2] === 'resume' && process.argv.length === 7) await recover(resolve(process.argv[3]), process.argv[4], process.argv[5], process.argv[6])
    else throw new Error('Expected source <run-id> <arm64|amd64|both> or resume <artifact-directory> <product.json> <source-commit> <arch>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
