// Local build-code tests only: no installation, Electron, deployment, or packaging.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { modules } from './overlay-review.mjs'

const root = resolve(import.meta.dirname, '../..')
const selected = process.argv[2]
if (process.argv.length > 3 || (selected && !modules.includes(selected))) {
  throw new Error(`Expected no argument or one module: ${modules.join(', ')}`)
}
function tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? tests(path) : entry.name.endsWith('.test.mjs') ? [path] : []
  })
}
const paths = tests(resolve(root, selected ? `build/modules/${selected}` : 'build'))
if (!paths.length) throw new Error(`No automated unit tests for ${selected}; see overlay-review for manual/staging checks`)
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...paths.sort()], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
