import { reactive } from 'vue'

/**
 * The console's confirmation, in place of the browser's confirm(): one dialog (ConfirmDialog.vue,
 * mounted once by the app) answers `await confirmAction(...)`. True only for the confirm button;
 * 取消, Esc or closing it any other way is false. Focus starts on 取消, so Enter never confirms by
 * accident. `danger` (the default) draws the red status bar and button.
 */
export interface ConfirmRequest {
  title: string
  text: string
  ok?: string
  danger?: boolean
}

export const pendingConfirm = reactive({ open: false, title: '', text: '', ok: '确认', danger: true })
let answer: ((confirmed: boolean) => void) | null = null

export function confirmAction({ title, text, ok = '确认', danger = true }: ConfirmRequest): Promise<boolean> {
  answer?.(false)
  Object.assign(pendingConfirm, { open: true, title, text, ok, danger })
  return new Promise((resolve) => {
    answer = resolve
  })
}

export function settleConfirm(confirmed: boolean) {
  pendingConfirm.open = false
  const resolve = answer
  answer = null
  resolve?.(confirmed)
}
