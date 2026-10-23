/* ============================================================
 * 产品覆盖：取消重启确认后仍然可以再次发起重启
 * ============================================================
 * 上游 desktop-actions.ts 的 requestRestart() 在 bootstrap.requestRestart()
 * 返回后把 restartCompleted 置为 true，之后每次调用都直接返回。可是 bootstrap
 * 那一侧（electron-runtime.confirmAndRestart）在用户点"取消"时同样正常返回——
 * 没有重启却被记成"已完成"，于是市场的"立即重启"按钮在用户取消过一次之后
 * 再也弹不出确认框，只能手动退出重开（2026-10-23 用户真机验收 v0.7.4 时命中）。
 *
 * 产品口径：重启真发生时进程就结束了，不需要"已完成"闩；只保留"进行中去重"，
 * 并在请求结束（确认或取消）后清掉，让下一次点击重新弹框。
 * 锚点自带守护：上游改动导致锚点失配时装配立即失败。
 * ============================================================ */
import { replaceOnce } from '../../pipeline/anchors.mjs'

const LABEL = 'runtime.restart-requestable'

/** 去掉"已完成"闩，重启请求结束后允许再次发起。 */
export function keepRestartRequestable(source) {
  if (source.includes('// product: no completed latch')) return source
  let next = replaceOnce(source, `  private disposed = false
  private restartCompleted = false
  private restartOperation: Promise<void> | undefined
`, `  private disposed = false
  private restartOperation: Promise<void> | undefined
`, LABEL)
  next = replaceOnce(next, `      this.assertActive()
      if (this.restartCompleted) return Promise.resolve()
      if (this.restartOperation !== undefined) return this.restartOperation
      const operation = (async () => {
        this.assertActive()
        await this.bootstrap.requestRestart()
        this.restartCompleted = true
      })()
      this.restartOperation = operation
      void operation.catch(() => {
        if (this.restartOperation === operation) this.restartOperation = undefined
      })
      return operation
`, `      this.assertActive()
      if (this.restartOperation !== undefined) return this.restartOperation
      // product: no completed latch — a cancelled confirmation returns normally too,
      // and a real restart ends the process, so only in-flight requests are deduplicated.
      let operation: Promise<void> | undefined
      operation = (async () => {
        try {
          this.assertActive()
          await this.bootstrap.requestRestart()
        } finally {
          // Cleared before the caller's await resumes, so a follow-up click can ask again.
          if (this.restartOperation === operation) this.restartOperation = undefined
        }
      })()
      this.restartOperation = operation
      return operation
`, LABEL)
  return next
}
