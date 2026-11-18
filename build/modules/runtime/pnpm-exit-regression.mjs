/* ====================================================================
 * 打包 pnpm 的退出回归（手动执行，不改 staging）
 *
 * 用装配好的宿主插件管理器 runProfilePnpm（service 模式，与市场安装/更新同一条路径）
 * 在临时 Profile 里驱动打包的 pnpm，确认每次操作打出 Done 后进程按时退出、退出码为 0，
 * package.json 与 pnpm-lock.yaml 的变化正确。
 *
 * 离线用例（默认）：本地夹具 registry，hoisted Profile、空 store，
 *   其他平台可选依赖（sharp 的 @img/* 形态）的 tarball 延迟返回。
 *   pnpm 11.8.0 在 remove/add 打出 Done 后被晚到的抓取新建线程池、进程不退出
 *   （pnpm/pnpm#12297、#13617，#13226 修复于 11.23.0），宿主一直等到静默上限才报失败；
 *   11.28.5 按时退出。
 * 联网用例（--live）：https://npm.tokensapi.ai/ 上的连接中心与报告插件，
 *   安装旧版、再按市场更新的顺序 remove + add 新版。鉴权读用户 ~/.npmrc。
 *
 * 用法：
 *   node build/modules/runtime/pnpm-exit-regression.mjs [--stage <装配目录>] [--pnpm <pnpm 包目录>]
 *     [--seed-pnpm <pnpm 包目录>] [--live] [--idle-ms <毫秒>]
 *   --stage      默认 .build/desktop；从中取 electron、插件管理器与打包的 pnpm
 *   --pnpm       改用另一份 pnpm（例如对照 11.8.0）
 *   --seed-pnpm  联网用例的首次安装改用这份 pnpm，模拟旧版本 pnpm 创建的 Profile
 * 只启动 electron 的 Node 模式（ELECTRON_RUN_AS_NODE=1），不打开任何窗口。
 * ==================================================================== */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '../../..')
const { values: flags } = parseArgs({
  options: {
    stage: { type: 'string', default: resolve(root, '.build/desktop') },
    pnpm: { type: 'string' },
    'seed-pnpm': { type: 'string' },
    live: { type: 'boolean', default: false },
    'idle-ms': { type: 'string' },
  },
})
const desktop = resolve(flags.stage, 'dsh-plugin-desktop')
const electron = resolve(desktop, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
const pnpmDir = resolve(flags.pnpm ?? resolve(desktop, 'node_modules/pnpm'))
const operations = resolve(desktop, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js')
for (const path of [electron, operations, join(pnpmDir, 'bin/pnpm.mjs')]) assert.ok(existsSync(path), `缺少 ${path}`)
const pnpmVersion = JSON.parse(readFileSync(join(pnpmDir, 'package.json'), 'utf8')).version
const electronVersion = JSON.parse(readFileSync(resolve(desktop, 'node_modules/electron/package.json'), 'utf8')).version
const { runProfilePnpm } = await import(pathToFileURL(operations).href)
const idleMs = Number(flags['idle-ms'] ?? (flags.live ? 180_000 : 20_000))
/** 打出 Done 之后多久内返回算按时退出；挂住的进程要等到静默上限。 */
const EXIT_AFTER_DONE_MS = 5_000

const work = mkdtempSync(join(tmpdir(), 'pnpm-exit-'))
// 与 Desktop 的 Node 垫片一致：子进程里的 node 仍是 Electron 的 Node 模式。
const nodeBin = join(work, 'node-bin')
mkdirSync(nodeBin)
if (process.platform === 'win32') writeFileSync(join(nodeBin, 'node.cmd'), `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${electron}" %*\r\nexit /b %errorlevel%\r\n`)
else writeFileSync(join(nodeBin, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electron}" "$@"\n`, { mode: 0o755 })
const inheritedPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]

/** Desktop profile-context.ts 的 packageManager：同样的命令、策略参数和环境。 */
function packageManager(pnpm, extraArgs) {
  return {
    command: electron,
    args: [join(pnpm, 'bin/pnpm.mjs'), '--config.minimumReleaseAge=0', ...extraArgs],
    env: {
      PATH: [nodeBin, inheritedPath].filter(Boolean).join(delimiter),
      NODE: join(nodeBin, process.platform === 'win32' ? 'node.cmd' : 'node'),
      ELECTRON_RUN_AS_NODE: '1',
      CI: 'true',
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_disturl: 'https://electronjs.org/headers',
    },
  }
}

function profile(name, dependencies = {}) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies }, null, 2)}\n`)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  return dir
}

const read = (dir, file) => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : ''
const dependenciesOf = dir => JSON.parse(read(dir, 'package.json')).dependencies ?? {}
const installedVersion = (dir, name) => {
  const text = read(dir, `node_modules/${name}/package.json`)
  return text ? JSON.parse(text).version : undefined
}

/** 一次宿主 pnpm 操作：结果、耗时、从 Done 到返回的时间。 */
async function host(dir, args, { pnpm = pnpmDir, extraArgs = [] } = {}) {
  const started = Date.now()
  let doneAt
  let output = ''
  const result = await runProfilePnpm({ profile: 'desktop', dir, installAnchor: dir, cwd: dir }, args, {
    execution: 'service', ...packageManager(pnpm, extraArgs), outputBytes: 1 << 20, activateNewBundles: false,
    idleTimeoutMs: idleMs, lookupTimeoutMs: 60_000,
    onOutput: text => { output += text; if (doneAt === undefined && /Done in /u.test(output)) doneAt = Date.now() - started },
  })
  const ms = Date.now() - started
  return { args: args.join(' '), exitCode: result.exitCode, timedOut: result.timedOut === true, ms, doneAt, afterDone: doneAt === undefined ? undefined : ms - doneAt, output }
}

const results = []
function expectExited(label, step) {
  const row = { label, args: step.args, exitCode: step.exitCode, timedOut: step.timedOut, ms: step.ms, afterDoneMs: step.afterDone }
  results.push(row)
  console.log(JSON.stringify(row))
  assert.equal(step.timedOut, false, `${label}: pnpm 打出 Done 后没有退出，宿主等到 ${idleMs}ms 静默上限才结束\n${step.output.slice(-600)}`)
  assert.equal(step.exitCode, 0, `${label}: 退出码 ${step.exitCode}\n${step.output.slice(-600)}`)
  assert.ok(step.doneAt !== undefined, `${label}: 输出里没有 Done\n${step.output.slice(-600)}`)
  assert.ok(step.afterDone <= EXIT_AFTER_DONE_MS, `${label}: Done 之后 ${step.afterDone}ms 才返回`)
}

// ---------- 离线夹具 registry ----------
function tarEntry(name, body) {
  const data = Buffer.from(body)
  const header = Buffer.alloc(512)
  const put = (value, offset, length) => header.write(value, offset, length, 'utf8')
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8)
  put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  put(`${Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, '0')}\0`, 136, 12)
  header.fill(' ', 148, 156); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2)
  let sum = 0
  for (const byte of header) sum += byte
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

async function fixtureRegistry(manifests) {
  const delays = new Map()
  const packuments = new Map()
  const tarballs = new Map()
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url.split('?')[0]).replace(/^\//u, '')
    const tarball = tarballs.get(path)
    if (tarball) {
      const timer = setTimeout(() => response.writeHead(200, { 'content-length': tarball.bytes.length }).end(tarball.bytes), delays.get(tarball.name) ?? 0)
      response.on('close', () => clearTimeout(timer))
      return
    }
    const packument = packuments.get(path)
    if (!packument) { response.writeHead(404, { 'content-type': 'application/json' }).end('{}'); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/`
  for (const manifest of manifests) {
    const bytes = gzipSync(Buffer.concat([
      tarEntry('package/package.json', JSON.stringify(manifest)),
      tarEntry('package/index.js', 'module.exports = {}\n'),
      Buffer.alloc(1024),
    ]))
    const file = `-/${manifest.name.replace('/', '__')}-${manifest.version}.tgz`
    tarballs.set(file, { name: manifest.name, bytes })
    packuments.set(manifest.name, {
      name: manifest.name,
      'dist-tags': { latest: manifest.version },
      time: { [manifest.version]: '2026-01-01T00:00:00.000Z' },
      versions: { [manifest.version]: { ...manifest, dist: {
        tarball: `${url}${file}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
      } } },
    })
  }
  return {
    url,
    delays,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()) }),
  }
}

async function offline() {
  // 与 sharp 一样：一个包带三平台可选原生包，只有当前平台的会被安装。
  const foreign = [['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'x64'], ['linux', 'arm64']]
    .filter(([os, cpu]) => os !== process.platform || cpu !== process.arch)
  const natives = [...foreign, [process.platform, process.arch]].map(([os, cpu]) => ({ name: `@fixture/native-${os}-${cpu}`, version: '1.0.0', os: [os], cpu: [cpu] }))
  const registry = await fixtureRegistry([
    ...natives,
    { name: '@fixture/image', version: '1.0.0', optionalDependencies: Object.fromEntries(natives.map(item => [item.name, '1.0.0'])) },
    { name: '@fixture/plugin-a', version: '1.0.0', dependencies: { '@fixture/image': '1.0.0' } },
    { name: '@fixture/plugin-b', version: '1.0.0' },
    { name: '@fixture/plugin-c', version: '1.0.0' },
  ])
  try {
    const store = join(work, 'offline-store')
    const extraArgs = [`--config.store-dir=${store}`, `--config.cache-dir=${join(work, 'offline-cache')}`]
    const dir = profile('offline')
    expectExited('离线 初次安装', await host(dir, ['add', '@fixture/plugin-a@1.0.0', '@fixture/plugin-b@1.0.0', `--registry=${registry.url}`], { extraArgs }))
    for (const [name, delay] of foreign.map(([os, cpu]) => [`@fixture/native-${os}-${cpu}`, 3_000])) registry.delays.set(name, delay)

    // 已安装的 Profile，store 被清空（换新 store、被 prune 或换了机器）：pnpm 会补抓不链接的其他平台包。
    rmSync(store, { recursive: true, force: true })
    expectExited('离线 卸载', await host(dir, ['remove', '@fixture/plugin-b', `--config.registry=${registry.url}`], { extraArgs }))
    assert.ok(!('@fixture/plugin-b' in dependenciesOf(dir)), '卸载后 package.json 仍列出 plugin-b')
    assert.doesNotMatch(read(dir, 'pnpm-lock.yaml'), /@fixture\/plugin-b/u, '卸载后锁文件仍有 plugin-b')
    assert.equal(installedVersion(dir, '@fixture/plugin-a'), '1.0.0')

    rmSync(store, { recursive: true, force: true })
    expectExited('离线 安装', await host(dir, ['add', '@fixture/plugin-c@1.0.0', `--registry=${registry.url}`], { extraArgs }))
    assert.equal(dependenciesOf(dir)['@fixture/plugin-c'], '1.0.0')
    assert.match(read(dir, 'pnpm-lock.yaml'), /'@fixture\/plugin-c@1\.0\.0'/u)
    assert.equal(installedVersion(dir, '@fixture/plugin-c'), '1.0.0')
    assert.equal(installedVersion(dir, `@fixture/native-${process.platform}-${process.arch}`), '1.0.0')
  } finally { await registry.close() }
}

async function live() {
  const registry = 'https://npm.tokensapi.ai/'
  const extraArgs = [`--config.store-dir=${join(work, 'live-store')}`, `--config.cache-dir=${join(work, 'live-cache')}`]
  const seed = flags['seed-pnpm'] ? resolve(flags['seed-pnpm']) : pnpmDir
  for (const [name, from, to] of [
    ['@tokensapi/dsh-connect', '2.10.0', '2.10.1'],
    ['@tokensapi/dsh-runzhou-report', '0.3.6', '0.3.7'],
  ]) {
    const dir = profile(`live-${name.split('/')[1]}`)
    expectExited(`${name} 安装 ${from}`, await host(dir, ['add', `${name}@${from}`, `--registry=${registry}`], { pnpm: seed, extraArgs }))
    assert.equal(dependenciesOf(dir)[name], from)
    assert.equal(installedVersion(dir, name), from)
    // 市场更新：先卸载旧版，再安装新版。
    expectExited(`${name} 更新-卸载 ${from}`, await host(dir, ['remove', name, `--config.registry=${registry}`], { extraArgs }))
    assert.ok(!(name in dependenciesOf(dir)), `${name} 卸载后 package.json 仍列出`)
    assert.ok(!read(dir, 'pnpm-lock.yaml').includes(`${name}@`), `${name} 卸载后锁文件仍有条目`)
    expectExited(`${name} 更新-安装 ${to}`, await host(dir, ['add', `${name}@${to}`, `--registry=${registry}`], { extraArgs }))
    assert.equal(dependenciesOf(dir)[name], to)
    assert.ok(read(dir, 'pnpm-lock.yaml').includes(`'${name}@${to}'`), `${name} 锁文件没有 ${to}`)
    assert.equal(installedVersion(dir, name), to)
    const modules = read(dir, 'node_modules/.modules.yaml')
    assert.match(modules, new RegExp(`"packageManager": "pnpm@${pnpmVersion.replaceAll('.', '\\.')}"`, 'u'))
  }
}

console.log(`pnpm ${pnpmVersion}（${pnpmDir}），Electron ${electronVersion}，静默上限 ${idleMs}ms，${flags.live ? '联网' : '离线'}用例`)
try {
  if (flags.live) await live()
  else await offline()
  // #13226 的修复本身：finishWorkers() 不再丢掉线程池引用，晚到的抓取复用已收尾的池，不会新建一个没人关闭的池。
  const bundle = readFileSync(join(pnpmDir, 'dist/pnpm.mjs'), 'utf8')
  const finishWorkers = bundle.slice(bundle.indexOf('async function finishWorkers() {'))
  assert.ok(bundle.includes('async function finishWorkers() {'), 'pnpm 包里找不到 finishWorkers')
  assert.doesNotMatch(finishWorkers.slice(0, finishWorkers.indexOf('\n}')), /workerPool = void 0/u, 'finishWorkers() 仍清空 workerPool（pnpm/pnpm#13226 之前的版本）')
  console.log(`pnpm-exit-regression: ${results.length} 步全部按时退出，finishWorkers 保留线程池引用（pnpm ${pnpmVersion}）`)
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
