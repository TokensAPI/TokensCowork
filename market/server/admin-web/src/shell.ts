import { onBeforeUnmount, reactive } from 'vue'

/**
 * What a page tells the frame around it: the sidebar counts it knows, when it last loaded (the
 * footer's 「更新于」), and what the header's 刷新 button does while it is open.
 */
export const shell = reactive({
  counts: {} as Record<string, number>,
  lastRefresh: 0,
  refresh: null as null | (() => Promise<unknown>),
})

/** The open page's refresh; dropped when the page goes away. */
export function useRefresh(refresh: () => Promise<unknown>) {
  shell.refresh = refresh
  onBeforeUnmount(() => {
    if (shell.refresh === refresh) shell.refresh = null
  })
}

export const formatTime = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
