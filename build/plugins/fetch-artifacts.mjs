import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const buildRoot = resolve(root, '.build')
const artifactsRoot = resolve(buildRoot, 'product-plugin-artifacts')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))

function fail(message) {
  throw new Error(`fetch-product-plugin-artifacts: ${message}`)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function runTar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) fail(`tar ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

function validateArchive(path, pluginId) {
  const entries = runTar(['-tzf', path]).split(/\r?\n/u).filter(Boolean)
  if (entries.length === 0) fail(`${pluginId} artifact is empty`)
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (!normalized.startsWith('package/') || normalized.split('/').includes('..')) {
      fail(`${pluginId} artifact contains an unsafe path: ${entry}`)
    }
  }
  const verboseEntries = runTar(['-tvzf', path]).split(/\r?\n/u).filter(Boolean)
  if (verboseEntries.some(entry => /^[lh]/u.test(entry))) {
    fail(`${pluginId} artifact contains a link entry`)
  }
}

async function downloadArtifact(plugin) {
  const artifact = plugin.artifact
  if (artifact.type !== 'npm-tgz') fail(`${plugin.id} artifact type must be npm-tgz`)
  if (!/^https:\/\//u.test(artifact.url)) fail(`${plugin.id} artifact URL must use HTTPS`)
  if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) fail(`${plugin.id} artifact SHA-256 is invalid`)

  mkdirSync(artifactsRoot, { recursive: true })
  const archivePath = resolve(artifactsRoot, `${plugin.id}-${artifact.sha256}.tgz`)
  let archive
  if (existsSync(archivePath)) {
    archive = readFileSync(archivePath)
  } else {
    const response = await fetch(artifact.url, { redirect: 'follow' })
    if (!response.ok) fail(`${plugin.id} artifact download returned HTTP ${response.status}`)
    archive = Buffer.from(await response.arrayBuffer())
  }
  const actualSha256 = sha256(archive)
  if (actualSha256 !== artifact.sha256) {
    fail(`${plugin.id} artifact SHA-256 mismatch: expected ${artifact.sha256}, got ${actualSha256}`)
  }
  if (!existsSync(archivePath)) writeFileSync(archivePath, archive)
  validateArchive(archivePath, plugin.id)

  const destination = resolve(artifactsRoot, plugin.id)
  const temporary = resolve(artifactsRoot, `.${plugin.id}-${process.pid}`)
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })
  runTar(['-xzf', archivePath, '-C', temporary])

  const packagePath = resolve(temporary, 'package', 'package.json')
  if (!existsSync(packagePath)) fail(`${plugin.id} artifact does not contain package/package.json`)
  const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (packageManifest.name !== (plugin.sourcePackage ?? plugin.package)
    || packageManifest.version !== plugin.version) {
    fail(`${plugin.id} artifact package identity differs from product.json`)
  }
  if (!existsSync(resolve(temporary, 'package', plugin.patch))) {
    fail(`${plugin.id} artifact is missing ${plugin.patch}`)
  }

  rmSync(destination, { recursive: true, force: true })
  renameSync(temporary, destination)
  process.stdout.write(`fetch-product-plugin-artifacts: ${plugin.id}@${plugin.version} ${actualSha256}\n`)
}

for (const plugin of product.plugins.filter(item => item.enabledByDefault === true && item.artifact !== undefined)) {
  await downloadArtifact(plugin)
}
