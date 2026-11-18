import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  alignPnpmDependency,
  alignPnpmNotice,
  alignPnpmPackageSpec,
  alignPnpmResolutions,
  normalizePatch,
  PNPM_PATCH,
} from './pnpm-version-overlay.mjs'

// 输入取固定的上游 Desktop 源码，不用拷贝的夹具。
const root = resolve(import.meta.dirname, '../../..')
const desktop = file => readFileSync(resolve(root, 'desktop', file), 'utf8')
const workspace = JSON.parse(desktop('package.json'))
const patchAsset = readFileSync(resolve(import.meta.dirname, 'assets', 'pnpm@11.28.5.patch'), 'utf8')

test('every workspace that bundles pnpm moves from 11.8.0 to 11.28.5', () => {
  const bundling = workspace.workspaces.filter(entry => JSON.parse(desktop(`${entry}/package.json`)).dependencies?.pnpm !== undefined)
  assert.deepEqual(bundling.sort(), ['dsh-desktop-next', 'dsh-plugin-desktop', 'dsh-plugin-desktop-beta'])
  for (const entry of bundling) {
    const manifest = alignPnpmDependency(JSON.parse(desktop(`${entry}/package.json`)), entry)
    assert.equal(manifest.dependencies.pnpm, '11.28.5')
    assert.deepEqual(alignPnpmDependency(structuredClone(manifest)), manifest, '幂等')
  }
  assert.throws(() => alignPnpmDependency({ dependencies: { pnpm: '11.30.0' } }), /复查 runtime\.pnpm-version/u)
})

test('the root resolution swaps the 11.8.0 patch entry for the upstream 11.28.5 one in place', () => {
  const before = Object.keys(workspace.resolutions)
  const result = alignPnpmResolutions(workspace.resolutions)
  assert.equal(result['pnpm@npm:11.28.5'], 'patch:pnpm@npm%3A11.28.5#./patches/pnpm@11.28.5.patch')
  assert.ok(!('pnpm@npm:11.8.0' in result))
  assert.equal(Object.keys(result).indexOf('pnpm@npm:11.28.5'), before.indexOf('pnpm@npm:11.8.0'))
  assert.equal(Object.keys(result).length, before.length)
  assert.deepEqual(alignPnpmResolutions(result), result, '幂等')
  assert.throws(() => alignPnpmResolutions({ 'pnpm@npm:11.9.0': 'npm:11.9.0' }), /pnpm 条目/u)
})

test('the patch asset is upstream 06446375 patches/pnpm@11.28.5.patch byte for byte (LF)', () => {
  const lf = normalizePatch(patchAsset)
  // git blob 哈希与上游 contents API 的 sha 一致（32ec0280…）。
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(lf)}\0`).update(lf).digest('hex')
  assert.equal(blob, '32ec0280c65c8cdb9c7a06aa5079f06e7d633bed')
  assert.equal(PNPM_PATCH, 'patches/pnpm@11.28.5.patch')
  // 与 11.8.0 补丁同一处修正：非正数或非数字的 minimumReleaseAge 关闭年龄检查。
  for (const line of [
    'const minimumReleaseAge = Number(opts3.minimumReleaseAge);',
    'Number.isFinite(minimumReleaseAge) && minimumReleaseAge > 0',
    'const configuredMinimumReleaseAge = Number(opts3.minimumReleaseAge);',
    '!Number.isFinite(ts) || !Number.isFinite(cutoff)',
  ]) assert.ok(lf.includes(line), line)
})

test('notices and both package specs name the bundled 11.28.5 and nothing else changes', () => {
  for (const variant of ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']) {
    const notice = alignPnpmNotice(desktop(`${variant}/THIRD_PARTY_NOTICES.md`))
    assert.ok(notice.includes('| pnpm | 11.28.5 | MIT |'))
    assert.ok(!notice.includes('| pnpm | 11.8.0 |'))
    assert.equal(alignPnpmNotice(notice), notice, '幂等')

    const source = desktop(`${variant}/tests/package.spec.ts`)
    const spec = alignPnpmPackageSpec(source)
    assert.equal(alignPnpmPackageSpec(spec), spec, '幂等')
    assert.ok(!spec.includes('11.8.0'), `${variant} package.spec 仍有 11.8.0`)
    for (const line of [
      "expect(manifest.dependencies?.pnpm).toBe('11.28.5')",
      "it('keeps the packaged pnpm manifest, lock entry, and installed runtime on 11.28.5'",
      "expect(lockfile).toContain('\"pnpm@npm:11.28.5\":')",
      "expect(installedPnpm.version).toBe('11.28.5')",
      "const patchPath = './patches/pnpm@11.28.5.patch'",
      "'pnpm@npm:11.28.5': patchResolution,",
      "expect(lockfile).toContain('pnpm@patch:pnpm@npm%3A11.28.5#./patches/pnpm@11.28.5.patch')",
    ]) assert.ok(spec.includes(line), `${variant}: ${line}`)
    // 只改版本号：去掉版本差异后与上游逐字相同。
    assert.equal(spec.replaceAll('11.28.5', '11.8.0'), source)
  }
})
