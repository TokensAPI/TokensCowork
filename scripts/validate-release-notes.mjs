#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const requiredReleaseSections = [
  '本次更新',
  '下载说明',
  '安装说明',
  '验证结果',
  '已知限制',
  '完整变更',
]

export function validateReleaseNotes({ content, version }) {
  const errors = []
  const expectedTitle = `# TokensHarness v${version}`
  const firstLine = content.split(/\r?\n/u, 1)[0]?.trim()

  if (firstLine !== expectedTitle) errors.push(`first line must be: ${expectedTitle}`)
  for (const section of requiredReleaseSections) {
    if (!content.includes(`## ${section}`)) {
      errors.push(`missing required section: ## ${section}`)
    }
  }
  if (/\{\{[^}]+\}\}/u.test(content)) errors.push('template placeholders must be resolved')
  if (/\b(?:TODO|TBD)\b/iu.test(content)) errors.push('TODO/TBD markers are not allowed')
  return errors
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value == null) {
      throw new Error('usage: validate-release-notes.mjs --version <x.y.z> --file <path>')
    }
    args[key.slice(2)] = value
  }
  return args
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(args.version)) {
    throw new Error('--version must be a valid release version')
  }
  if (!args.file) throw new Error('--file is required')
  const content = fs.readFileSync(args.file, 'utf8')
  const errors = validateReleaseNotes({ content, version: args.version })
  if (errors.length > 0) {
    for (const error of errors) console.error(`release notes error: ${error}`)
    process.exit(1)
  }
  process.stdout.write(`${args.file}\n`)
}
