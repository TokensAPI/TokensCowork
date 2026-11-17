// Runs before styles paint; contains no account or credential data.
;(() => {
  const key = 'tokenscowork-market-theme'
  const system = window.matchMedia('(prefers-color-scheme: dark)')
  const valid = value => ['light', 'dark', 'system'].includes(value) ? value : 'system'
  let preference = 'system'
  try { preference = valid(localStorage.getItem(key)) } catch {}
  // data-theme drives the docs center's own styles, data-bs-theme the console's Tabler styles.
  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.bsTheme = theme
    const control = document.getElementById('theme-choice')
    if (control) control.value = preference
  }
  apply()
  system.addEventListener('change', apply)
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue)
      apply()
    }
  })
  document.addEventListener('DOMContentLoaded', () => {
    apply()
    document.getElementById('theme-choice').addEventListener('change', event => {
      preference = valid(event.target.value)
      try { localStorage.setItem(key, preference) } catch {}
      apply()
    })
  })
})()
