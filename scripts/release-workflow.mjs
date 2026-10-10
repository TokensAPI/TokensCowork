// 发布入口的快速校验：昂贵的插件回归、编译和公证之前拒绝重复或不匹配的目标。
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateReleaseNotes } from './validate-release-notes.mjs'

const root = resolve(import.meta.dirname, '..')

export function validateReleaseTarget({ operation, tag, version, commit, tagCommit, release, eventTag }) {
  if (!['build', 'promote'].includes(operation)) throw new Error('Unknown release operation')
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || tag !== `v${version}`) throw new Error('Release tag differs from product version')
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit')
  if (eventTag && eventTag !== tag) throw new Error('Pushed tag differs from product version')
  if (tagCommit && tagCommit !== commit) throw new Error('Release tag points to a different source commit')
  if (operation === 'build' && release) throw new Error('Release already exists; do not rebuild or resubmit notarization')
  if (operation === 'promote' && (!release || release.draft || !release.prerelease)) throw new Error('Promotion requires an existing published pre-release')
  return { operation, tag, version, commit, release_notes: `docs/releases/${tag}.md`, prerelease: 'true' }
}

export async function readRelease(repository, tag, token, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error('Invalid repository or tag')
  const response = await request(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Release query failed (HTTP ${response.status}); no build started`)
  return response.json()
}

export async function main(env = process.env) {
  const operation = env.RELEASE_OPERATION || 'build'
  if (!['build', 'promote'].includes(operation)) throw new Error('Unknown release operation')
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  let tag, version, commit
  if (operation === 'promote') {
    tag = env.RELEASE_TAG
    if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Promotion requires tag vX.Y.Z')
    commit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])
    version = JSON.parse(git(['show', `${commit}:product.json`])).product.version
  } else {
    version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim()
    for (const file of ['package.json', 'product.json']) {
      const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
      if ((file === 'product.json' ? manifest.product.version : manifest.version) !== version) throw new Error(`${file} differs from VERSION`)
    }
    tag = env.RELEASE_TAG || `v${version}`
    commit = git(['rev-parse', 'HEAD'])
    if (env.GITHUB_SHA && env.GITHUB_SHA !== commit) throw new Error('Checkout differs from triggering commit')
  }
  const existing = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd: root, encoding: 'utf8' })
  if (existing.error || ![0, 1].includes(existing.status)) throw new Error('Cannot inspect release tag')
  const release = await readRelease(env.GITHUB_REPOSITORY, tag, env.GH_TOKEN)
  const metadata = validateReleaseTarget({ operation, tag, version, commit, tagCommit: existing.status === 0 ? existing.stdout.trim() : undefined, release, eventTag: env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : undefined })
  const notes = readFileSync(resolve(root, metadata.release_notes), 'utf8')
  const errors = validateReleaseNotes({ content: notes, version, fullTemplate: true })
  if (errors.length) throw new Error(errors.join('\n'))
  // 稳定版校验说明覆盖范围和原安装包；此处只读，回归通过后才 --apply。
  if (operation === 'promote') execFileSync(process.execPath, ['scripts/promote-release.mjs', tag], { cwd: root, env: { ...env, RELEASE_SOURCE_COMMIT: commit }, stdio: 'inherit' })
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''))
  console.log(JSON.stringify(metadata, null, 2))
  return metadata
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
