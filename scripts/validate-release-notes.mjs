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

export function validateReleaseNotes({ content, version, fullTemplate = false }) {
  const errors = []
  const expectedTitle = `# TokensCowork v${version}`
  const firstLine = content.split(/\r?\n/u, 1)[0]?.trim()

  if (firstLine !== expectedTitle) errors.push(`first line must be: ${expectedTitle}`)
  // The opening paragraph also feeds the stable-to-stable upgrade summary.
  // Release channel changes must not make that paragraph inaccurate.
  const introduction = content.split(/\r?\n/u).slice(1).join('\n').trimStart()
    .split(/\n\s*\n|\n(?=#{1,6}\s)/u, 1)[0].trim()
  if (!introduction || /^#{1,6}\s/u.test(introduction)) {
    errors.push('summary must contain a paragraph describing the changes')
  } else if (/^(?:本次更新|本次发布|本版本|本次为|本(?:预发布|正式|稳定|测试|候选)(?:版|版本))/u.test(introduction)
    || /(?:预发布(?:版|版本|候选)|正式版|稳定版|测试版|候选版|\bpre[- ]?release\b|\bstable release\b|\bofficial release\b)/iu.test(introduction)) {
    errors.push('summary must describe changes directly without release-channel wording or 本次更新/本版本/本次为')
  }
  const headings = [...content.matchAll(/^## ([^\r\n]+)\r?$/gm)].map(match => ({ name: match[1], index: match.index, end: match.index + match[0].length }))
  for (const section of requiredReleaseSections) {
    if (!headings.some(heading => heading.name === section)) {
      errors.push(`missing required section: ## ${section}`)
    }
  }
  if (fullTemplate) {
    const english = ["What's New", 'Downloads', 'Installation', 'Verification', 'Known Limitations', 'Full Changelog']
    const expected = [...requiredReleaseSections, ...english]
    if (JSON.stringify(headings.map(heading => heading.name)) !== JSON.stringify(expected)) {
      errors.push('full template requires the six Chinese and six English sections in order, without duplicates')
    }
    function section(name) {
      const index = headings.findIndex(heading => heading.name === name)
      return index < 0 ? '' : content.slice(headings[index].end, headings[index + 1]?.index ?? content.length)
    }
    for (const name of expected) {
      const text = section(name).replace(/^#{3,6}[^\r\n]*$/gm, '').replace(/<!--[^]*?-->/g, '').trim()
      if (!text) errors.push(`full template section must contain content: ${name}`)
    }
    const categories = [['✨ 新增功能', '✨ New Features'], ['🐛 问题修复', '🐛 Bug Fixes'], ['🎨 体验优化', '🎨 Improvements'], ['⚠️ 其他变更', '⚠️ Other Changes']]
    let count = 0
    for (const [zh, en] of categories) {
      const hasZh = section('本次更新').includes(`### ${zh}`)
      const hasEn = section("What's New").includes(`### ${en}`)
      if (hasZh) count++
      if (hasZh !== hasEn) errors.push(`update category must appear in both languages: ${zh}`)
    }
    if (!count) errors.push('full template requires at least one update category')
    for (const name of ['下载说明', 'Downloads']) {
      const text = section(name)
      if (!/^\|.+\|/m.test(text)) errors.push(`download table is required: ${name}`)
      for (const suffix of ['windows-amd64-installer.exe', 'macos-arm64-installer.dmg', 'macos-amd64-installer.dmg', 'SHA256SUMS.txt', 'plugins.json']) {
        const url = `https://github.com/TokensAPI/TokensCowork/releases/download/v${version}/TokensCowork-${version}-${suffix}`
        if (!text.includes(url)) errors.push(`missing current-version asset link in ${name}: ${suffix}`)
      }
    }
    for (const [name, subheadings] of [['安装说明', ['Windows', 'macOS', '从旧版本升级']], ['Installation', ['Windows Installation', 'macOS Installation', 'Upgrading from an Earlier Version']]]) {
      for (const heading of subheadings) {
        if (!section(name).includes(`### ${heading}`)) errors.push(`missing installation subsection: ${heading}`)
      }
    }
    for (const [name, title] of [['本次更新', '内置组件与插件'], ["What's New", 'Bundled Components and Plugins']]) {
      const text = section(name).split(`### ${title}`)[1]?.split(/^### /m)[0] ?? ''
      if (!/^\|.+\|/m.test(text)) errors.push(`missing bundled components table: ${title}`)
    }
    for (const name of ['完整变更', 'Full Changelog']) {
      if (!new RegExp(`https://github\\.com/TokensAPI/TokensCowork/compare/v[^\\s)]+\\.\\.\\.v${version.replaceAll('.', '\\.')}[)\\s]`).test(section(name))) {
        errors.push(`changelog must compare to current version: ${name}`)
      }
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
  if (args.format !== undefined && args.format !== 'full') throw new Error('--format must be full')
  const errors = validateReleaseNotes({ content, version: args.version, fullTemplate: args.format === 'full' })
  if (errors.length > 0) {
    for (const error of errors) console.error(`release notes error: ${error}`)
    process.exit(1)
  }
  process.stdout.write(`${args.file}\n`)
}
