import { readFileSync } from 'node:fs'
export function fullNotes(version = '0.5.14', previous = '0.5.13') {
  return readFileSync(new URL('../docs/releases/TEMPLATE.md', import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n')
    .replace(/\{\{([^}]+)\}\}/g, (_, key) => key === 'VERSION' ? version : key === 'PREVIOUS_VERSION' ? previous : 'Verified content.')
}
