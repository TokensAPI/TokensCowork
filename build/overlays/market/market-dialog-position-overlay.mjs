// The tenant theme must not replace native dialog geometry (including fullscreen masks).
const rule = 'html[data-theme="clean"] [role="dialog"] {\n  position: relative;\n'

export function preserveNativeDialogPosition(clientBundle) {
  // Published UI artifacts embed chrome.css as a JSON-escaped JS string.
  const anchor = JSON.stringify(rule).slice(1, -1)
  if (clientBundle.split(anchor).length !== 2) {
    throw new Error('market-dialog-position: theme rule changed; review whether the native-position fix is still needed')
  }
  return clientBundle.replace(anchor, JSON.stringify(rule.replace('  position: relative;\n', '')).slice(1, -1))
}
