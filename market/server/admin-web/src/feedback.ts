import { reactive } from 'vue'
import { errorText } from './api'

/**
 * The console's one toast, as at /admin/: a success fades after five seconds, an error stays until
 * it is closed or the next operation starts.
 */
export const toast = reactive({ message: '', kind: 'success' as 'success' | 'error', serial: 0 })
let timer: ReturnType<typeof setTimeout> | undefined

export function notify(message = '', kind: 'success' | 'error' = 'success') {
  clearTimeout(timer)
  toast.message = message
  toast.kind = kind
  toast.serial++
  if (message && kind !== 'error') timer = setTimeout(() => notify(), 5000)
}

/**
 * Runs one operation and reports how it went: the success message, or the error in the toast and,
 * through `onError`, wherever else it belongs (a dialog's own error line). Resolves whether it worked.
 */
export async function runAction(fn: () => Promise<unknown>, { success, onError }: { success?: string; onError?: (message: string, error: unknown) => void } = {}) {
  notify()
  try {
    await fn()
    if (success) notify(success)
    return true
  } catch (error) {
    notify(errorText(error), 'error')
    onError?.(error instanceof Error ? error.message : String(error), error)
    return false
  }
}
