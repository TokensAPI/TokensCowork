import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = 'TokensAPI/TokensCowork'
export function retentionPlan(releases, files) {
  const keep = [], remove = []
  for (const minor of [1, 2, 3]) {
    const pattern = new RegExp(`^v0\\.${minor}\\.(\\d+)$`)
    const series = releases.filter(release => !release.draft && pattern.test(release.tag_name))
      .sort((a, b) => Number(b.tag_name.match(pattern)[1]) - Number(a.tag_name.match(pattern)[1]))
    keep.push(...series.slice(0, 3).map(release => release.tag_name))
    remove.push(...series.slice(3).map(release => release.tag_name))
  }
  const draftTags = new Set(releases.filter(release => release.draft).map(release => release.tag_name))
  const removeDocs = files.filter(file => /^v0\.[123]\.\d+\.md$/.test(file) && !keep.includes(file.slice(0, -3)) && !draftTags.has(file.slice(0, -3)))
  return { keep, removeReleases: remove, removeDocs }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--apply')) throw new Error('Expected optional --apply; default is dry-run')
  const root = resolve(import.meta.dirname, '..')
  const releases = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' })).flat()
  const directory = resolve(root, 'docs/releases')
  const plan = retentionPlan(releases, readdirSync(directory))
  console.log(JSON.stringify(plan, null, 2))
  if (args.includes('--apply')) {
    const backup = resolve(root, '.build/diagnostics', `release-retention-${Date.now()}.json`)
    mkdirSync(dirname(backup), { recursive: true })
    writeFileSync(backup, JSON.stringify({ repository, plan, releases, docs: Object.fromEntries(plan.removeDocs.map(file => [file, readFileSync(resolve(directory, file), 'utf8')])) }, null, 2))
    console.log(`Metadata and Markdown backup: ${backup}`)
    for (const tag of plan.removeReleases) {
      if (!/^v0\.[123]\.\d+$/.test(tag)) throw new Error(`Out-of-scope tag: ${tag}`)
      // Delete the Release and its assets, preserving Git tags and source history.
      execFileSync('gh', ['release', 'delete', tag, '--repo', repository, '--yes'], { stdio: 'inherit' })
      console.log(`Deleted Release and assets: ${tag}`)
    }
    for (const file of plan.removeDocs) {
      if (!/^v0\.[123]\.\d+\.md$/.test(file)) throw new Error(`Out-of-scope file: ${file}`)
      const path = resolve(directory, file)
      if (dirname(path) !== directory) throw new Error('Markdown target escaped release directory')
      unlinkSync(path)
    }
    console.log(`Removed ${plan.removeReleases.length} Releases and ${plan.removeDocs.length} Markdown files; tags preserved.`)
  }
}
