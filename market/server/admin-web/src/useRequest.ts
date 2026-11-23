import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'

export interface Request<T> {
  /** The latest answer; kept while a newer request is pending, so a list does not blank out. */
  data: ShallowRef<T | undefined>
  /** The latest request's error, cleared when the next one starts. */
  error: Ref<Error | null>
  loading: Ref<boolean>
  /**
   * Starts a request. Resolves true when its answer was taken, false when it failed or a newer
   * request started meanwhile -- an answer that arrives late never replaces a newer one.
   */
  run: () => Promise<boolean>
}

/** One page's read: loading state, error, and only the latest answer counts. */
export function useRequest<T>(load: () => Promise<T>): Request<T> {
  const data = shallowRef<T>()
  const error = ref<Error | null>(null)
  const loading = ref(false)
  let latest = 0
  async function run() {
    const turn = ++latest
    loading.value = true
    error.value = null
    try {
      const value = await load()
      if (turn !== latest) return false
      data.value = value
      return true
    } catch (cause) {
      if (turn === latest) error.value = cause instanceof Error ? cause : new Error(String(cause))
      return false
    } finally {
      if (turn === latest) loading.value = false
    }
  }
  return { data, error, loading, run }
}
