// Runs before styles paint, so a dark theme never flashes light first. The same preference as the
// console at /admin/ (localStorage 'tokenscowork-market-theme': light, dark or system); the page's
// theme control (src/theme.ts) takes over once it is running. No account or credential data here.
;(() => {
  let preference = 'system'
  try {
    const saved = localStorage.getItem('tokenscowork-market-theme')
    if (saved === 'light' || saved === 'dark') preference = saved
  } catch {}
  const theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.bsTheme = theme
})()
