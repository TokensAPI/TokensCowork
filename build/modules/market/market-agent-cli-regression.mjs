// Real DSH CLI regression. Uses a new DSH_HOME; never touches the user's Profile.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const home = await mkdtemp(join(tmpdir(), 'cowork-agent-cli-'))
const profile = join(home, 'profiles', 'qa')
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const config = join(home, 'qa.npmrc')
await writeFile(config, 'ignore-scripts=true\nauto-install-peers=false\nfetch-retries=0\nfetch-timeout=30000\n' +
  'store-dir=' + join(home, 'store').replaceAll('\\', '/') + '\ncache-dir=' + join(home, 'cache').replaceAll('\\', '/') + '\n')
const desktop = fileURLToPath(new URL('../../../.build/desktop/dsh-plugin-desktop/', import.meta.url))
const cli = join(desktop, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const results = []
const name = '@tokensapi/dsh-plugin-check'
async function run(args) {
  const child = spawn(process.execPath, [cli, 'plugin', '--profile', 'qa', ...args,
    '--store-dir=' + join(home, 'store'), '--cache-dir=' + join(home, 'cache'),
    ...(args[0] === 'add' ? ['--ignore-scripts', '--fetch-retries=0', '--fetch-timeout=30000'] : [])], {
    cwd: home, env: { ...process.env, DSH_HOME: home, NODE_OPTIONS: '', NPM_CONFIG_USERCONFIG: config,
      PATH: [join(desktop, 'node_modules/.bin'), dirname(process.execPath), process.env.PATH].join(delimiter) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => output += data)
  child.stderr.on('data', data => output += data)
  const timer = setTimeout(() => child.kill(), 180000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)) })
  clearTimeout(timer)
  return { code, output: output.replace(/sk-[\w-]+/g, '[redacted]') }
}
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'pass' }); console.log('PASS', name) }
  catch (error) { results.push({ name, status: 'fail', error: error.message }); console.log('FAIL', name, error.message) }
}
await check('bare Agent CLI reproduces public npm 404 (expected limitation)', async () => {
  const result = await run(['add', '--registry=https://registry.npmjs.org/', '--@tokensapi:registry=https://registry.npmjs.org/', name + '@0.4.0'])
  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, /ERR_PNPM_FETCH_404/, result.output)
})
await check('Agent CLI explicit shared market route installs package', async () => {
  const result = await run(['add', '--save-exact', '--registry=https://registry.npmjs.org/', '--@tokensapi:registry=https://market.tokensapi.ai/registry/by-package/', name + '@0.4.0'])
  assert.equal(result.code, 0, result.output)
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes(name), 'CLI must register the bundle')
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules', name, 'package.json'), 'utf8')).version, '0.4.0')
})
await check('Agent CLI removes only test plugin', async () => {
  const result = await run(['remove', name])
  assert.equal(result.code, 0, result.output)
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(!manifest.dependencies?.[name])
  assert.ok(!manifest.dsh.profile.bundles.includes(name))
})
await writeFile(join(home, 'results.json'), JSON.stringify({ date: new Date().toISOString(), home, results }, null, 2))
console.log('Evidence', join(home, 'results.json'))
process.exitCode = results.some(r => r.status === 'fail') ? 1 : 0
