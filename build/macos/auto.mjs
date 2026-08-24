import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { selectMacSigningMode } from './signing-mode.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const signingMode = selectMacSigningMode(process.env)
const buildMode = signingMode === 'signed' ? 'mac' : 'mac-unsigned'

process.stdout.write(`macOS signing mode: ${signingMode}\n`)
const result = spawnSync(process.execPath, [resolve(root, 'build', 'build-desktop.mjs'), buildMode], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) process.exitCode = result.status ?? 1
