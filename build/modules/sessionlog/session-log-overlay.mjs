/* ============================================================
 * 产品覆盖:会话日志上传
 * ============================================================
 * 产品内置 tokens-session-log 插件后,停用上游设置页的
 * 「在使用官方模型 API 时上传 Session Log」开关(dsh-web-app
 * cordis.patch.yml 的 `ui-settings-session-log` 行)。上游上传只夹带在
 * DeepSeek 官方模型请求里,产品走 TokensAPI 时该开关不起作用;
 * 产品插件在 设置 → 通用设置 的同一位置(order 90)注册自己的开关。
 * ============================================================ */

/**
 * 在 Desktop 补丁层追加停用上游 ui-settings-session-log 的覆盖条目。
 * 与 disableUpstreamRepeatReminder 同一机制:补丁按层组合,以 id 定向覆盖。
 * @param patch - staging 副本中 cordis.patch.yml 的完整内容。
 * @returns 追加停用覆盖条目后的补丁内容。
 * @throws 补丁层已存在 ui-settings-session-log 行时抛出,中断打包待人工复查。
 */
export function disableUpstreamSessionLogSetting(patch) {
  if (patch.includes('ui-settings-session-log')) {
    throw new Error('prepare-desktop: Desktop 补丁层已出现 ui-settings-session-log 行,请复查会话日志覆盖配置')
  }
  return `${patch}\n\n# 产品覆盖:上游 Session Log 开关只对 DeepSeek 官方 API 生效,已由 tokens-session-log 的开关取代,予以停用。\n`
    + '- id: ui-settings-session-log\n  disabled: true'
}
