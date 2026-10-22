import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertCompleteTestOutput, isolatedPackageEnvironment, installCommand, outputTail, parseOptions, runPluginTests, testEnvironment, testScript, withGitBash } from './test-product-plugins.mjs'

function workflowJob(source, id) {
  const jobs = source.replaceAll('\r\n', '\n').split(/^jobs:\s*$/m)[1]
  const entries = [...jobs.matchAll(/^  ([\w-]+):\s*$/gm)]
  const index = entries.findIndex(entry => entry[1] === id)
  assert.notEqual(index, -1, `Missing workflow job: ${id}`)
  return jobs.slice(entries[index].index, entries[index + 1]?.index)
}

test('Yarn entry cannot inject the outer PnP loader into an isolated npm/pnpm dependency tree', () => {
  for (const injected of ['--require C:/repo/.pnp.cjs', '-r "C:/repo with spaces/.pnp.cjs"', '--experimental-loader=file:///repo/.pnp.loader.mjs', '--import file:///repo/.pnp.loader.mjs']) {
    const source = { NODE_OPTIONS: `${injected} --max-old-space-size=4096 --require /user/hook.cjs`, MARKER: 'retained' }
    const clean = isolatedPackageEnvironment(source)
    assert.equal(clean.NODE_OPTIONS, '--max-old-space-size=4096 --require /user/hook.cjs')
    assert.equal(clean.MARKER, 'retained')
    assert.ok(source.NODE_OPTIONS.includes('.pnp.'))
  }
  assert.equal(isolatedPackageEnvironment({ NODE_OPTIONS: '--require C:/repo/.pnp.cjs' }).NODE_OPTIONS, undefined)
})

test('host fixtures use the isolated workspace drive instead of the system temporary drive', () => {
  const env = testEnvironment('D:/workspace/outer', 'D:/workspace/tmp')
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(env[key], 'D:/workspace/tmp')
  assert.equal(env.TOKENS_OUTER_ROOT, 'D:/workspace/outer')
  assert.equal(env.DSH_RUNTIME_ROOT, join('D:/workspace/outer', 'desktop', 'deepseek-harness', 'apps', 'cli'))
})

test('exit zero with skipped or incomplete tests cannot satisfy the promotion gate', () => {
  assertCompleteTestOutput('72/72 cases passed; all passed.\n# skipped 0\n# todo 0')
  assertCompleteTestOutput('✔ rejects incomplete configuration\nℹ skipped 0\nℹ todo 0')
  for (const output of ['# skipped 1', 'ℹ skipped 1', 'Tests 12 passed | 2 skipped', 'INCOMPLETE CASE-001', '# todo 1']) {
    assert.throws(() => assertCompleteTestOutput(output))
  }
})

test('existing case runners take priority; missing scripts remain excluded', () => {
  assert.equal(testScript({ scripts: { test: 'vitest run', 'test:cases': 'node cases.mjs' } }), 'test:cases')
  assert.equal(testScript({ scripts: { test: 'node --test' } }), 'test')
  assert.equal(testScript({}), undefined)
})

test('tag arguments cannot turn into Git options or arbitrary shell commands', () => {
  assert.deepEqual(parseOptions(['--ref', 'v0.5.19', '--plan']), { ref: 'v0.5.19', plan: true, failFast: false })
  assert.deepEqual(parseOptions(['--fail-fast']), { ref: 'HEAD', plan: false, failFast: true })
  for (const args of [['--ref'], ['--ref', '--help'], ['--ref', 'v1;echo bad'], ['--unknown']]) {
    assert.throws(() => parseOptions(args))
  }
})

test('release regression stops at the first failing plugin and reports unexecuted tests', () => {
  const plan = ['account', 'model', 'search'].map(id => ({ id, version: '1.0.0', commit: 'a'.repeat(40), script: 'test:cases' }))
  for (const failedIndex of [0, 1, 2]) {
    const executed = []
    const reports = []
    const results = runPluginTests(plan, plugin => {
      executed.push(plugin.id)
      if (plugin.id === plan[failedIndex].id) throw new Error('fixture test failure')
      return { caseSummary: { passed: 1 } }
    }, results => reports.push(structuredClone(results)), { failFast: true })
    assert.deepEqual(executed, plan.slice(0, failedIndex + 1).map(plugin => plugin.id))
    assert.deepEqual(results.map(result => result.status), plan.map((_, index) => index < failedIndex ? 'passed' : index === failedIndex ? 'failed' : 'not-run'))
    assert.equal(results[failedIndex].error, 'fixture test failure')
    assert.equal(reports.length, failedIndex + 1)
    assert.deepEqual(reports.at(-1), results)
  }
})

test('manual regression collects subsequent failures and excludes plugins without a test entry', () => {
  const plan = [{ id: 'first', script: 'test' }, { id: 'missing' }, { id: 'last', script: 'test:cases' }]
  const executed = []
  const results = runPluginTests(plan, plugin => {
    executed.push(plugin.id)
    throw new Error(`${plugin.id} failed`)
  }, () => {})
  assert.deepEqual(executed, ['first', 'last'])
  assert.deepEqual(results.map(result => result.status), ['failed', 'not-configured', 'failed'])
})

test('successful fail-fast regression still executes every configured plugin', () => {
  const plan = [{ id: 'first', script: 'test' }, { id: 'missing' }, { id: 'last', script: 'test:cases' }]
  const executed = []
  const results = runPluginTests(plan, plugin => { executed.push(plugin.id) }, () => {}, { failFast: true })
  assert.deepEqual(executed, ['first', 'last'])
  assert.deepEqual(results.map(result => result.status), ['passed', 'not-configured', 'passed'])
})

test('lockfiles select frozen dependency installation instead of rewriting source locks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-install-plan-'))
  try {
    writeFileSync(join(directory, 'pnpm-lock.yaml'), '')
    assert.deepEqual(installCommand(directory, { packageManager: 'pnpm@11.7.0' }), ['corepack', ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--ignore-scripts']])
    writeFileSync(join(directory, 'package-lock.json'), '{}')
    assert.equal(installCommand(directory, {})[1][0], 'ci')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('promotion runs the tag regression gate before applying Release changes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8')
  const regression = readFileSync(new URL('../.github/workflows/test-builtin-plugins.yml', import.meta.url), 'utf8')
  const pluginTests = workflowJob(workflow, 'plugin-tests')
  const promotion = workflowJob(workflow, 'promote-release')
  assert.match(pluginTests, /uses: \.\/\.github\/workflows\/test-builtin-plugins.yml/)
  assert.match(pluginTests, /ref: \$\{\{ needs.metadata.outputs.commit \}\}/)
  // T0047: the regression also runs on pre-release builds and gates their publish, not only promotions.
  assert.match(pluginTests, /if: needs.metadata.outputs.operation == 'build' \|\| needs.metadata.outputs.operation == 'promote'/)
  const publish = workflowJob(workflow, 'publish-release')
  assert.match(publish, /needs: \[metadata, build-packages, plugin-tests\]/)
  assert.match(promotion, /needs: \[metadata, plugin-tests\]/)
  assert.match(promotion, /if: needs.metadata.outputs.operation == 'promote'/)
  assert.match(regression, /workflow_dispatch:/)
  assert.match(regression, /submodules: recursive/)
  assert.match(regression, /runs-on: windows-2025/)
  assert.match(regression, /corepack yarn test:plugins --ref "\$env:PRODUCT_REF"/)
  assert.doesNotMatch(regression, /continue-on-error/)
  assert.doesNotMatch(promotion, /if: always\(\)|continue-on-error/)
})

test('prerelease builds only three installers with fail-fast publication gating', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8')
  const parallel = workflowJob(workflow, 'build-packages')
  assert.match(parallel, /needs: metadata\s+if: needs.metadata.outputs.operation == 'build'/)
  assert.match(parallel, /fail-fast: true/)
  // 三个安装包 + 一个与 Windows 打包并行的质量门禁任务。
  assert.deepEqual([...parallel.matchAll(/^            platform: (.+)\r?$/gm)].map(match => match[1].trim()), ['windows-check', 'windows', 'macos', 'macos'])
  // Intel 包在 Apple Silicon 上交叉打包，x64 smoke 靠 Rosetta；Intel runner 慢 3–4 倍。
  assert.deepEqual([...parallel.matchAll(/^            runner: (.+)\r?$/gm)].map(match => match[1].trim()), ['windows-2022', 'windows-2022', 'macos-14', 'macos-14'])
  assert.match(parallel, /if: matrix.platform == 'windows-check'\n        run: \|\n          corepack yarn test:uninstall\n          corepack yarn product:check:win/)
  assert.match(parallel, /if: matrix.platform == 'windows'\n        run: corepack yarn product:dist:win/)
  assert.match(parallel, /softwareupdate --install-rosetta --agree-to-license/)
  assert.match(parallel, /if: matrix.platform == 'macos' && matrix.electron_arch == 'x64'/)
  assert.doesNotMatch(parallel, /test:plugins|matrix.task|task: plugins/)
  assert.match(parallel, /ref: \$\{\{ needs.metadata.outputs.commit \}\}/)
  assert.match(parallel, /if: always\(\) && matrix.platform == 'macos' && steps.signing.outputs.mode == 'signed'/)
  assert.match(parallel, /if: needs.metadata.outputs.operation == 'build' \|\| needs.metadata.outputs.operation == 'rehearse'/)
  const publication = workflowJob(workflow, 'publish-release')
  assert.match(publication, /needs: \[metadata, build-packages, plugin-tests\]/)
  // 演练不发布；发布任务不得用 always() 或 continue-on-error 放过失败的安装包。
  assert.match(publication, /if: needs.metadata.outputs.operation == 'build'\n/)
  assert.doesNotMatch(publication, /always\(\)|continue-on-error:/)
  // 只有缓存可忽略失败，编译、签名、公证和附件校验均不可放宽。
  assert.equal((parallel.match(/continue-on-error: true/g) ?? []).length, 1)
  assert.match(parallel, /uses: actions\/cache@v5\s+continue-on-error: true/)
})

test('fresh package and regression checkouts fetch the target Harness pin before use', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8')
  const parallel = workflowJob(workflow, 'build-packages')
  const pin = parallel.split('      - name: 准备 · 固定 Harness 提交\n')[1]?.split('      - name:')[0]
  assert.ok(pin, 'Harness preparation must exist in the release matrix')
  assert.doesNotMatch(pin, /if:|continue-on-error:/)
  assert.match(pin, /product\.json.*desktop\.deepseekHarnessCommit/)
  assert.match(pin, /git -C desktop\/deepseek-harness fetch --no-tags --no-recurse-submodules origin "\$commit"/)
  assert.match(pin, /git -C desktop\/deepseek-harness checkout --detach "\$commit"/)
  assert.match(pin, /submodule update --init --recursive/)
  assert.ok(parallel.indexOf('准备 · 固定 Harness 提交') < parallel.indexOf('corepack yarn product:dist:win'))
  const regression = readFileSync(new URL('../.github/workflows/test-builtin-plugins.yml', import.meta.url), 'utf8')
  const prepare = regression.split('      - name: 准备 · 固定 Harness 提交\n')[1]?.split('      - name:')[0]
  assert.ok(prepare, 'Promotion/manual regression must prepare the pinned Harness on fresh runners')
  assert.match(prepare, /PRODUCT_REF: \$\{\{ inputs.ref \|\| github.sha \}\}/)
  assert.match(prepare, /parseOptions\(\["--ref", process.env.PRODUCT_REF\]\)/)
  assert.match(prepare, /execFileSync\("git", \["show", `\$\{ref\}:product.json`\]/)
  assert.match(prepare, /product.desktop.deepseekHarnessCommit/)
  assert.match(prepare, /checkout --detach "\$commit"/)
  assert.ok(regression.indexOf('准备 · 固定 Harness 提交') < regression.indexOf('corepack yarn test:plugins'))
})

test('download cache fallback stays platform-specific and excludes generated applications', () => {
  const release = readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8')
  const cache = workflowJob(release, 'build-packages').split('      - name: 准备 · 恢复构建缓存')[1]?.split('      - name:')[0]
  assert.ok(cache)
  assert.match(cache, /key: desktop-build-v1-\$\{\{ runner.os \}\}-\$\{\{ runner.arch \}\}-\$\{\{ hashFiles\('build\/pipeline\/product.yarn.lock'\) \}\}/)
  assert.match(cache, /restore-keys: \|\s+desktop-build-v1-\$\{\{ runner.os \}\}-\$\{\{ runner.arch \}\}-/)
  assert.match(cache, /Library\/Caches\/node-gyp/)
  assert.match(cache, /~\/\.electron-gyp/)
  assert.doesNotMatch(cache, /node_modules|signed-app|mac-recovery|dist\//)
})

test('regression shares its own lock while release requests cannot cancel an active release', () => {
  const release = readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8')
  const regression = readFileSync(new URL('../.github/workflows/test-builtin-plugins.yml', import.meta.url), 'utf8')
  assert.match(release, /group: product-release\s+cancel-in-progress: false/)
  assert.match(regression, /group: product-plugin-regression\s+cancel-in-progress: false/)
  assert.match(release, /group: product-package-\$\{\{ github.run_id \}\}-\$\{\{ matrix.platform \}\}-\$\{\{ matrix.arch \}\}/)
  // 取消后重试保留原报告，避免同名附件冲突再次触发失败。
  assert.match(regression, /name: plugin-regression-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/)
})

test('download deployment has one release trigger and no release-event redispatch loop', () => {
  const page = readFileSync(new URL('../.github/workflows/deploy-download-page.yml', import.meta.url), 'utf8')
  const release = readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8')
  const name = release.match(/^name: (.+)$/m)[1]
  assert.ok(page.includes(`      - ${name}`))
  assert.doesNotMatch(page, /^  release:|redispatch:|gh workflow run/m)
  assert.match(page, /workflow_run.conclusion == 'success'/)
  assert.doesNotMatch(page, /submodules: recursive/)
})

test('Windows plugin tests resolve bash to Git Bash instead of WSL', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-bash-'))
  try {
    for (const dir of ['cmd', join('mingw64', 'bin'), 'bin']) mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'bin', 'bash.exe'), '')
    // `where git` may list mingw64\bin\git.exe first; the Git root is still found.
    const located = () => `${join(root, 'mingw64', 'bin', 'git.exe')}\r\n${join(root, 'cmd', 'git.exe')}\r\n`
    const env = withGitBash({ Path: 'C:\\Windows\\System32' }, 'win32', located)
    assert.equal(env.Path, [join(root, 'bin'), 'C:\\Windows\\System32'].join(';'))
    assert.deepEqual(withGitBash({ PATH: '/usr/bin' }, 'linux'), { PATH: '/usr/bin' })
    assert.deepEqual(withGitBash({ Path: 'x' }, 'win32', () => ''), { Path: 'x' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed command reports the tail of its output', () => {
  assert.equal(outputTail(''), '')
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const tail = outputTail(`${lines.join('\n')}\n\x1b[31mERROR boom\x1b[0m`)
  assert.match(tail, /ERROR boom$/)
  assert.doesNotMatch(tail, /line 9\n/)
})

test('the weekly cache warm-up reads exactly the cache the release build writes', () => {
  const release = readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const warm = readFileSync(new URL('../.github/workflows/warm-build-cache.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const block = (text, marker) => {
    const start = text.indexOf(marker)
    assert.ok(start > 0, `缺少步骤 ${marker}`)
    const body = text.slice(text.indexOf('        with:\n', start) + 14)
    // 只比 path / key / restore-keys 的内容，注释行不计。
    return body.slice(0, body.search(/\n(?! {10})/)).split('\n').filter(line => !/^\s*#/.test(line)).join('\n').trim()
  }
  // path / key / restore-keys 三段逐字一致，预热刷新的才是发版那份缓存。
  assert.equal(block(warm, '预热 · 读取构建缓存'), block(release, '准备 · 恢复构建缓存'))
  assert.match(warm, /uses: actions\/cache\/restore@v5/)
  assert.match(warm, /schedule:\n    - cron:/)
  // 预热不执行任何命令：没有 run 步骤，只有 checkout 与缓存读取。
  assert.doesNotMatch(warm, /\n\s+run:/)
  for (const runner of ['windows-2022', 'macos-14']) assert.ok(warm.includes(runner), `预热缺少 ${runner}`)
  assert.ok(!warm.includes('macos-15-intel'), '发布已不用 Intel runner，不必预热它的缓存')
})
