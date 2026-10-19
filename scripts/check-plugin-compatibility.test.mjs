import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultProfile, evaluate, parseOptions, profilePlugins, stagedPlugins } from './check-plugin-compatibility.mjs'

/** Stand-in for the host's own check: blocks whenever a DSH peer excludes the runtime. */
const hostCheck = (manifest, _exemptions, runtime) => {
  const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
    .filter(([name, range]) => name.startsWith('@deepseek-ai/dsh') && !range.includes(runtime)))
  return Object.keys(peers).length === 0 ? undefined : { peers, exempted: false }
}

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-test-'))
  try { return run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('profile bundles resolve to their installed manifests; a missing list is not an error', () => {
  withDir(dir => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@tokensapi/x', 7] } } }))
    assert.deepEqual(profilePlugins(dir).map(entry => entry.name), ['@deepseek-ai/dsh-base', '@tokensapi/x'])
    assert.match(profilePlugins(dir)[1].manifestPath, /node_modules[\\/]@tokensapi[\\/]x[\\/]package\.json$/u)
    assert.deepEqual(profilePlugins(join(dir, 'absent')), [])
  })
})

test('built-in plugins come from the staged product-plugins directory', () => {
  withDir(dir => {
    mkdirSync(join(dir, 'dsh-plugin-desktop', 'product-plugins', 'tokens-login'), { recursive: true })
    assert.deepEqual(stagedPlugins(dir).map(entry => entry.name), ['tokens-login'])
    assert.deepEqual(stagedPlugins(join(dir, 'absent')), [])
  })
})

test('each plugin is reported as ok, blocked or missing, keeping only the offending peers', () => {
  withDir(dir => {
    const write = (name, manifest) => {
      const path = join(dir, name)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'package.json'), JSON.stringify(manifest))
      return { name, manifestPath: join(path, 'package.json') }
    }
    const entries = [
      write('good', { version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1 <0.3', react: '^18' } }),
      write('old', { version: '0.4.4', peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.3-alpha.1', react: '^18' } }),
      { name: 'absent', manifestPath: join(dir, 'absent', 'package.json') },
    ]
    const results = evaluate(hostCheck, entries, '>=0.1 <0.3')
    assert.deepEqual(results.map(result => result.status), ['ok', 'blocked', 'missing'])
    assert.equal(results[1].version, '0.4.4')
    // Only DSH peers that actually block are reported, so the fix is obvious.
    assert.deepEqual(results[1].peers, { '@deepseek-ai/dsh-tools': '0.1.3-alpha.1' })
  })
})

test('a manifest the host refuses to read is surfaced, not swallowed', () => {
  withDir(dir => {
    mkdirSync(join(dir, 'bad'), { recursive: true })
    writeFileSync(join(dir, 'bad', 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const throwing = () => { throw new Error('peerDependencies must be an object') }
    const [result] = evaluate(throwing, [{ name: 'bad', manifestPath: join(dir, 'bad', 'package.json') }], '0.2.0')
    assert.equal(result.status, 'error')
    assert.match(result.message, /peerDependencies/u)
  })
})

test('options and the default profile', () => {
  assert.deepEqual(parseOptions(['--json']), { profile: undefined, json: true })
  assert.equal(parseOptions(['--profile', 'C:/p']).profile, 'C:/p')
  assert.throws(() => parseOptions(['--oops']), /Usage/u)
  assert.match(defaultProfile('C:/home/.dsh'), /profiles[\\/]desktop$/u)
})
