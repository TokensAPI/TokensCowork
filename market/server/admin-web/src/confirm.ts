import { reactive } from 'vue'

/**
 * The console's confirmation, in place of the browser's confirm(): one dialog (ConfirmDialog.vue,
 * mounted once by the app) answers `await confirmAction(...)`. True only for the confirm button;
 * 取消, Esc or closing it any other way is false. Focus starts on 取消, so Enter never confirms by
 * accident. `danger` (the default) draws the red status bar and button. `items` lists what a
 * deletion takes (at most eight, then 「…以及另外 N 个」) and `note` adds a closing line.
 *
 * confirmDiscard() is the same dialog in its 「放弃未保存的修改？」 form, asked before an edit
 * dialog with changes is closed.
 */
export interface ConfirmRequest {
  title: string
  text: string
  ok?: string
  danger?: boolean
  items?: string[]
  note?: string
}

export const pendingConfirm = reactive({
  open: false, title: '', text: '', ok: '确认', danger: true, items: [] as string[], more: 0, note: '', discard: false,
})
let answer: ((confirmed: boolean) => void) | null = null

function ask(fields: Partial<typeof pendingConfirm>): Promise<boolean> {
  answer?.(false)
  Object.assign(pendingConfirm, { title: '', text: '', ok: '确认', danger: true, items: [], more: 0, note: '', discard: false }, fields, { open: true })
  return new Promise((resolve) => {
    answer = resolve
  })
}

export function confirmAction({ title, text, ok = '确认', danger = true, items = [], note = '' }: ConfirmRequest): Promise<boolean> {
  return ask({ title, text, ok, danger, items: items.slice(0, 8), more: Math.max(0, items.length - 8), note })
}

export function confirmDiscard(): Promise<boolean> {
  return ask({ title: '放弃未保存的修改？', text: '修改尚未生效。可以返回继续编辑，或放弃本次草稿。', ok: '放弃修改', discard: true })
}

export function settleConfirm(confirmed: boolean) {
  pendingConfirm.open = false
  const resolve = answer
  answer = null
  resolve?.(confirmed)
}
