/* ============================================================
 * 产品覆盖：检查更新的弹窗带上发布说明
 * ============================================================
 * 更新插件只有拿得到 Electron 的 dialog 时才用自己的弹窗规格；而插件实际跑在
 * 宿主进程里（宿主是 Desktop 启动的子进程，且以 electron-as-node 运行），
 * `import('electron')` 拿不到 dialog，于是它回退成
 * `adapter.showManualCheckResult(result)` ——由宿主用自己的文案显示，
 * 插件 0.1.5 查到的发布说明被整段丢掉（2026-10-26 用户真机：弹窗只有
 * 「当前已是最新版本。/ 当前版本：0.7.5」两行）。
 *
 * 宿主交给插件的 updates 适配器形状是固定的，没有通用弹窗入口，所以两头各补一刀：
 *   - 插件侧：回退时把插件自己渲染好的正文挂在结果的 `notesText` 上（用的就是
 *     插件自带的 renderReleaseNotes，解析口径只有一份）；
 *   - 宿主侧：显示结果时若带 `notesText` 就接在详情后面，没有则逐字照旧。
 * 两个锚点都自带守护：上游或插件改了这两处，装配立即失败而不是静默失效。
 * ============================================================ */
import { insertBefore, replaceOnce } from '../../pipeline/anchors.mjs'

const PLUGIN_LABEL = 'updates.manual-check-notes-source'
const HOST_LABEL = 'updates.manual-check-notes'

/** 插件侧：回退给宿主显示时，把渲染好的发布说明一并交过去。 */
export function attachReleaseNotesToResult(source) {
  if (source.includes('notesText')) return source
  return replaceOnce(source, `      if (electron === null) return adapter.showManualCheckResult(result)`,
    `      if (electron === null) {
        // 产品覆盖：插件在宿主进程里没有 Electron 对话框，结果交回宿主显示；宿主的
        // 文案不含发布说明，这里把插件自己渲染好的正文挂上去（解析仍只有这一份）。
        const notesText = result === null
          ? ''
          : renderReleaseNotes(result.notes, ctx.desktopRuntime.locale)
        return adapter.showManualCheckResult(notesText === '' ? result : { ...result, notesText })
      }`, PLUGIN_LABEL)
}

/** 宿主侧：手动检查的结果弹窗里显示插件带来的发布说明。 */
export function showReleaseNotesInManualCheck(source) {
  if (source.includes('withReleaseNotes')) return source
  let next = insertBefore(source, `  /** Report one user-triggered check without exposing network or response details. */`,
    `  /**
   * 产品覆盖：更新插件在宿主进程里没有 Electron 对话框，回退到这里显示结果时会把
   * 自己渲染好的发布说明放在 \`notesText\` 上。有就接在详情后面，没有就逐字照旧。
   * @param detail - 宿主原本要显示的详情。
   * @param result - 更新插件交回来的检查结果。
   * @returns 带发布说明的详情，或原样的详情。
   */
  private withReleaseNotes(detail: string, result: UpdateCheckResult): string {
    const notes = (result as { readonly notesText?: unknown }).notesText
    return typeof notes === 'string' && notes.trim() !== '' ? \`\${detail}\\n\\n\${notes}\` : detail
  }

`, HOST_LABEL)
  next = replaceOnce(next, `        detail: copy.installedVersion(result.currentVersion),`,
    `        detail: this.withReleaseNotes(copy.installedVersion(result.currentVersion), result),`, HOST_LABEL)
  return replaceOnce(next, `      detail: copy.installerUnavailable,`,
    `      detail: this.withReleaseNotes(copy.installerUnavailable, result),`, HOST_LABEL)
}
