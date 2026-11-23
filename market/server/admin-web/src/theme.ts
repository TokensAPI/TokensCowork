import { ref, watch } from 'vue'

/**
 * Light, dark or the system's: the same setting as the console at /admin/ and the docs center
 * (market-theme.js), under the same storage key, so choosing it in one changes all of them, open
 * tabs included. public/theme.js applies it before the first paint; this keeps it applied.
 */
export type ThemePreference = 'light' | 'dark' | 'system'
export const THEME_KEY = 'tokenscowork-market-theme'
const valid = (value: unknown): ThemePreference => (value === 'light' || value === 'dark' || value === 'system' ? value : 'system')

function saved(): ThemePreference {
  try {
    return valid(localStorage.getItem(THEME_KEY))
  } catch {
    return 'system'
  }
}

export const themePreference = ref<ThemePreference>(saved())

function apply() {
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  const theme = themePreference.value === 'system' ? (dark ? 'dark' : 'light') : themePreference.value
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.bsTheme = theme
}

/** Chosen in this tab: remembered (when the browser allows it) and applied. */
export function chooseTheme(value: string) {
  themePreference.value = valid(value)
  try {
    localStorage.setItem(THEME_KEY, themePreference.value)
  } catch {}
}

let started = false
export function startTheme() {
  if (started) return
  started = true
  apply()
  watch(themePreference, apply)
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY || event.key === null) themePreference.value = valid(event.newValue)
  })
}
