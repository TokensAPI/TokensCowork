/* ============================================================
 * 产品覆盖:循环护栏
 * ============================================================
 * 产品内置 tokens-loop-guard 插件后,停用上游 repeat-tool-reminder:
 * 上游只做精确匹配且只提醒(见 dsh-base cordis.patch.yml 的
 * `repeat-tool-reminder` 行),产品插件同时覆盖精确与近似重复,
 * 并在高阈值硬阻断。两者同开会对同一次重复注入两条提醒。
 * 每个导出函数自带锚点守护:失配时装配立即失败,等待人工复查。
 * ============================================================ */

/**
 * 在 Desktop 补丁层追加停用上游 repeat-tool-reminder 的覆盖条目。
 * 上游注册行在 dsh-base 的 cordis.patch.yml(`- id: repeat-tool-reminder`),
 * 补丁按层组合,这里以 id 定向覆盖,与 disableUpstreamUpdates 同一机制。
 * @param patch - staging 副本中 cordis.patch.yml 的完整内容。
 * @returns 追加停用覆盖条目后的补丁内容。
 * @throws 补丁层已存在 repeat-tool-reminder 行时抛出,中断打包待人工复查。
 */
export function disableUpstreamRepeatReminder(patch) {
  if (patch.includes('repeat-tool-reminder')) {
    throw new Error('prepare-desktop: Desktop 补丁层已出现 repeat-tool-reminder 行,请复查循环护栏覆盖配置')
  }
  return `${patch}\n\n# 产品覆盖:上游 repeat-tool-reminder 仅精确匹配且只提醒,已由 tokens-loop-guard 取代,予以停用。\n`
    + '- id: repeat-tool-reminder\n  disabled: true'
}
