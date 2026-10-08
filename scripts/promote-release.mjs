import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { validateReleaseNotes } from './validate-release-notes.mjs'
import { buildReleaseNotes } from './generate-plugin-manifest.mjs'
const { compareVersions } = createRequire(import.meta.url)('../download/release-notes.js')

export function validatePromotion(release, releases, notes) {
  const version = release.tag_name.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Promotion requires a plain x.y.z product tag')
  if (release.draft || release.prerelease !== true) throw new Error('Only a published pre-release can be promoted')
  const errors = validateReleaseNotes({ content: notes, version, fullTemplate: true })
  if (errors.length) throw new Error(errors.join('\n'))
  for (const suffix of ['windows-amd64-installer.exe', 'macos-arm64-installer.dmg', 'macos-amd64-installer.dmg', 'SHA256SUMS.txt', 'plugins.json']) {
    if (!release.assets.some(asset => asset.name === `TokensCowork-${version}-${suffix}` && asset.size > 0)) {
      throw new Error(`Missing published asset: ${suffix}`)
    }
  }
  const stable = releases.filter(item => !item.draft && item.prerelease === false)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0]
  if (stable && compareVersions(release.tag_name, stable.tag_name) <= 0) throw new Error('Cannot promote a version older than the latest stable release')
  if (stable) {
    for (const title of ['完整变更', 'Full Changelog']) {
      const section = notes.split(`## ${title}`)[1]?.split(/^## /m)[0] ?? ''
      if (!section.includes(`/compare/${stable.tag_name}...${release.tag_name}`)) {
        throw new Error(`Stable notes must cover changes since ${stable.tag_name}; update both changelog links and review the cumulative changes`)
      }
    }
  }
  return { version, previousStable: stable?.tag_name ?? null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, option] = process.argv.slice(2)
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || (option !== undefined && option !== '--apply') || process.argv.length > 4) {
    throw new Error('Usage: node scripts/promote-release.mjs v<x.y.z> [--apply]; default is dry-run')
  }
  const repository = 'TokensAPI/TokensCowork'
  const releases = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' })).flat()
  const release = releases.find(item => item.tag_name === tag)
  if (!release) throw new Error(`Release not found: ${tag}`)
  const notes = readFileSync(resolve(import.meta.dirname, `../docs/releases/${tag}.md`), 'utf8')
  const result = validatePromotion(release, releases, notes)
  // Distribution must come from the original tag, never the moving default branch.
  const manifest = JSON.parse(execFileSync('git', ['show', `${tag}:product.json`], { encoding: 'utf8' }))
  if (manifest.product.version !== result.version) throw new Error('Tag product version differs from Release')
  console.log(JSON.stringify({ tag, ...result, assetsPreserved: release.assets.length, apply: option === '--apply' }, null, 2))
  if (option === '--apply') {
    const directory = mkdtempSync(resolve(tmpdir(), 'tokens-release-promotion-'))
    const file = resolve(directory, 'release-notes.md')
    writeFileSync(file, buildReleaseNotes(manifest, notes))
    execFileSync('gh', ['release', 'edit', tag, '--repo', repository, '--prerelease=false', '--latest', '--notes-file', file], { stdio: 'inherit' })
    console.log(`Promoted ${tag}; existing tag and installer assets preserved.`)
  }
}
