import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import afterSign, { inspectHistory, waitForAcceptance, validateRecoveryState, verifySignedApp, validateSourceRun, inspectSource, recover, sha256, queryNotary, runMac } from './mac-notarization.mjs'

const id = 'cfdabdcb-ea33-4498-911e-84f12ac2d946'
const commit = 'a'.repeat(40)
const expected = { version: '0.5.17', commit, arch: 'arm64', appId: 'com.tokensapi.tokenscowork', productName: 'TokensCowork' }

test('history only queries product submissions and never uploads or resumes them', () => {
  const calls = []
  const rows = inspectHistory({}, args => {
    calls.push(args)
    return args[0] === 'history' ? { history: [{ id, name: 'signed-app.zip', createdDate: '2026-10-09' }, { id: 'unrelated', name: 'other.app' }] } : { status: 'Accepted' }
  })
  assert.deepEqual(calls, [['history'], ['info', id]])
  assert.ok(rows.some(row => row.includes('Accepted')))
})

test('polls original submission until Accepted; timeouts and rejection never resubmit', async () => {
  let time = 0
  const requests = []
  const query = args => { requests.push(args); return { status: requests.length === 2 ? 'Accepted' : 'In Progress' } }
  await waitForAcceptance(id, { query, now: () => time, sleep: async ms => { time += ms } })
  assert.deepEqual(requests, [['info', id], ['info', id]])
  await assert.rejects(waitForAcceptance(id, { query: () => ({ status: 'Invalid' }) }), /inspect/)
  await assert.rejects(waitForAcceptance(id, { query: () => ({ status: 'In Progress' }), now: () => time, sleep: async ms => { time += ms }, minutes: 0.5 }), /resume/)
  await assert.rejects(waitForAcceptance('bad-id'), /Invalid/)
})

test('recovery rejects mismatched source, changed payload and missing submission ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'notary-state-'))
  try {
    const archive = join(root, 'signed-app.zip')
    writeFileSync(archive, 'signed fixture')
    const state = { ...expected, submissionId: id, sha256: sha256(archive) }
    validateRecoveryState(state, expected, archive)
    for (const key of Object.keys(expected)) assert.throws(() => validateRecoveryState({ ...state, [key]: 'different' }, expected, archive), /does not match/)
    assert.throws(() => validateRecoveryState({ ...state, submissionId: undefined }, expected, archive), /Invalid/)
    writeFileSync(archive, 'changed fixture')
    assert.throws(() => validateRecoveryState(state, expected, archive), /modified/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('signed app verification rejects universal executable and preserves Developer ID and notarization gates', () => {
  const calls = []
  const run = (command, args) => {
    calls.push([command, args])
    if (command.endsWith('PlistBuddy')) return args[1].endsWith('CFBundleIdentifier') ? expected.appId : expected.version
    if (command === 'lipo') return 'arm64'
    return ''
  }
  verifySignedApp('/fixture.app', expected, true, run)
  assert.ok(calls.some(([command, args]) => command === 'codesign' && args.some(arg => arg.includes('anchor apple generic'))))
  assert.ok(calls.some(([command]) => command === 'spctl'))
  assert.ok(calls.some(([command, args]) => command === 'xcrun' && args[1] === 'validate'))
  assert.throws(() => verifySignedApp('/fixture.app', expected, false, (command, args) => command === 'lipo' ? 'arm64 x86_64' : run(command, args)), /exactly/)
})

test('source run must be this repository, completed, from trusted workflow with successful metadata', () => {
  const run = { status: 'completed', head_repository: { full_name: 'TokensAPI/TokensCowork' }, path: '.github/workflows/release.yml', event: 'push', head_sha: commit }
  const jobs = [{ name: 'Resolve VERSION', conclusion: 'success' }]
  for (const path of ['.github/workflows/release-desktop.yml', '.github/workflows/release.yml']) {
    for (const name of ['Resolve VERSION', '准备 · 校验发布目标']) {
      assert.equal(validateSourceRun({ ...run, path }, 'TokensAPI/TokensCowork', [{ name, conclusion: 'success' }]), commit)
    }
    assert.throws(() => validateSourceRun({ ...run, path }, 'TokensAPI/TokensCowork', [{ name: '准备 · 校验发布目标', conclusion: 'failure' }]))
  }
  for (const invalid of [{ status: 'in_progress' }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'fork/repo' } }, { event: 'pull_request' }]) assert.throws(() => validateSourceRun({ ...run, ...invalid }, 'TokensAPI/TokensCowork', jobs))
  assert.throws(() => validateSourceRun(run, 'TokensAPI/TokensCowork', []))
})

test('recovery packages saved app, verifies mounted DMG, and never builds, signs or submits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notary-recover-'))
  try {
    const archive = join(root, 'signed-app.zip')
    writeFileSync(archive, 'signed fixture')
    writeFileSync(join(root, 'notarization.json'), JSON.stringify({ ...expected, submissionId: id, sha256: sha256(archive) }))
    const manifest = join(root, 'product.json')
    writeFileSync(manifest, JSON.stringify({ product: { name: expected.productName, version: expected.version, appId: expected.appId } }))
    const calls = [], verified = []
    await recover(root, manifest, commit, 'arm64', {
      wait: async submission => assert.equal(submission, id),
      run: (command, args) => { calls.push([command, args]); if (command === 'hdiutil' && args[0] === 'create') writeFileSync(args.at(-1), 'dmg fixture') },
      verify: (app, state, notarized) => verified.push({ app, notarized }),
      link: (target, path) => assert.equal(target, '/Applications'),
    })
    assert.equal(verified.length, 3)
    assert.ok(verified.at(-1).app.includes('mount'))
    assert.ok(verified.at(-1).notarized)
    assert.ok(calls.some(([command, args]) => command === 'hdiutil' && args[0] === 'detach'))
    assert.ok(calls.every(([command, args]) => ['ditto', 'xcrun', 'hdiutil'].includes(command) && !args.includes('submit')))
    assert.match(readFileSync(join(root, 'TokensCowork-0.5.17-macos-arm64-BUILD-INFO.txt'), 'utf8'), new RegExp(`submission_id=${id}`))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('authentication errors and malformed Apple output do not expose credentials', () => {
  assert.throws(() => runMac(process.execPath, ['-e', 'process.stderr.write("secret-value");process.exit(1)']), error => !error.message.includes('secret-value'))
  assert.throws(() => queryNotary(['history'], () => 'secret-value', { APPLE_ID: 'fixture', APPLE_APP_PASSWORD: 'secret-value', APPLE_TEAM_ID: 'fixture' }), /invalid notarization JSON/)
})

test('hook skips Windows before any signing or notarization access', async () => {
  await afterSign({ electronPlatformName: 'win32' })
})

test('recovery dispatch resolves original commit and rejects missing or expired saved payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'notary-source-'))
  try {
    const output = join(root, 'outputs')
    const env = { GITHUB_REPOSITORY: 'TokensAPI/TokensCowork', GITHUB_OUTPUT: output }
    const original = { status: 'completed', head_repository: { full_name: env.GITHUB_REPOSITORY }, path: '.github/workflows/release-desktop.yml', event: 'push', head_sha: commit, run_attempt: 1 }
    const artifacts = [{ name: 'mac-notarization-arm64-0.5.17', expired: false }]
    const run = (command, args) => {
      assert.equal(command, 'gh')
      const path = args[1]
      if (path.includes('/jobs?')) return JSON.stringify({ jobs: [{ name: '准备 · 校验发布目标', conclusion: 'success' }] })
      if (path.includes('/artifacts?')) return JSON.stringify({ artifacts })
      if (path.includes('/contents/')) return JSON.stringify({ content: Buffer.from(JSON.stringify({ product: { version: expected.version } })).toString('base64') })
      return JSON.stringify(original)
    }
    inspectSource('123', 'arm64', env, run)
    const result = readFileSync(output, 'utf8')
    assert.match(result, new RegExp(`commit=${commit}`))
    assert.match(result, /"arch":"arm64"/)
    assert.throws(() => inspectSource('123', 'both', env, run), /saved signed payload/)
    artifacts[0].expired = true
    assert.throws(() => inspectSource('123', 'arm64', env, run), /saved signed payload/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
