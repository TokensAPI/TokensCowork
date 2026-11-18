/* ====================================================================
 * 打包 pnpm 11.8.0 → 11.28.5
 * pnpm 11.8.0 的 finishWorkers() 清空线程池引用，打出 Done 之后晚到的抓取
 * （其他平台的可选依赖，常见于 sharp 的 @img/*）会新建一个没人关闭的池，
 * 进程不退出（pnpm/pnpm#12297、#13617；#13226 修复于 11.23.0）。宿主插件管理器
 * 等 pnpm 退出，市场更新插件就卡到静默上限并误报失败。上游 Desktop 已在
 * 271cc526 换成 11.28.5，并把 minimumReleaseAge 补丁移植为 patches/pnpm@11.28.5.patch。
 * ==================================================================== */
import { replaceOnce } from '../../pipeline/anchors.mjs'

export const PNPM_FROM = '11.8.0'
export const PNPM_TO = '11.28.5'
export const PNPM_PATCH = `patches/pnpm@${PNPM_TO}.patch`
const fromSelector = `pnpm@npm:${PNPM_FROM}`
const toSelector = `pnpm@npm:${PNPM_TO}`
const toResolution = `patch:pnpm@npm%3A${PNPM_TO}#./${PNPM_PATCH}`

/** 工作区清单里固定的 pnpm 换成新版本；其他版本说明上游已变，需要复查本覆盖。 */
export function alignPnpmDependency(manifest, label = 'package.json') {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const current = manifest[field]?.pnpm
    if (current === undefined || current === PNPM_TO) continue
    if (current !== PNPM_FROM) throw new Error(`${label} 的 ${field}.pnpm 是 ${current}，不是预期的 ${PNPM_FROM}；上游已换版本，复查 runtime.pnpm-version`)
    manifest[field].pnpm = PNPM_TO
  }
  return manifest
}

/** 根 resolutions：去掉 11.8.0 的补丁条目，换成上游 11.28.5 的条目。 */
export function alignPnpmResolutions(resolutions) {
  if (resolutions[toSelector] === toResolution && !(fromSelector in resolutions)) return resolutions
  const pnpmSelectors = Object.keys(resolutions).filter(selector => selector.startsWith('pnpm@'))
  if (pnpmSelectors.length !== 1 || pnpmSelectors[0] !== fromSelector) {
    throw new Error(`根 resolutions 的 pnpm 条目应只有 ${fromSelector}，实际：${pnpmSelectors.join(', ') || '无'}`)
  }
  // 保持原有位置，便于与上游对照。
  return Object.fromEntries(Object.entries(resolutions)
    .map(([selector, source]) => selector === fromSelector ? [toSelector, toResolution] : [selector, source]))
}

/** THIRD_PARTY_NOTICES 里的打包版本。 */
export function alignPnpmNotice(notice) {
  const after = `| pnpm | ${PNPM_TO} | MIT |`
  if (notice.includes(after)) return notice
  return replaceOnce(notice, `| pnpm | ${PNPM_FROM} | MIT |`, after, 'THIRD_PARTY_NOTICES pnpm')
}

/** 补丁按 LF 写入：Yarn 按行比对 dist/pnpm.mjs，CRLF 检出的副本会对不上。 */
export const normalizePatch = text => text.replaceAll('\r\n', '\n')

/**
 * Desktop package.spec 中断言打包 pnpm 版本的三处：manifest 依赖、锁文件与已安装版本、补丁条目。
 * 补丁内容断言（minimumReleaseAge 的几行）两个版本相同，不改。
 */
export function alignPnpmPackageSpec(spec) {
  if (spec.includes(`'keeps the packaged pnpm manifest, lock entry, and installed runtime on ${PNPM_TO}'`)) return spec
  const start = spec.indexOf(`    expect(manifest.dependencies?.pnpm).toBe('${PNPM_FROM}')\n  })`)
  const endAnchor = "    expect(installedRuntime).not.toContain('const ageCheckActive = Boolean(opts3.minimumReleaseAge);')"
  const end = spec.indexOf(endAnchor)
  if (start < 0 || end < start) throw new Error('package.spec 的打包 pnpm 断言段落变了')
  const block = spec.slice(start, end)
  const expectedCount = 11
  const count = block.split(PNPM_FROM).length - 1
  if (count !== expectedCount) throw new Error(`package.spec 的打包 pnpm 断言段落应出现 ${expectedCount} 次 ${PNPM_FROM}，实际 ${count} 次`)
  return spec.slice(0, start) + block.replaceAll(PNPM_FROM, PNPM_TO) + spec.slice(end)
}
