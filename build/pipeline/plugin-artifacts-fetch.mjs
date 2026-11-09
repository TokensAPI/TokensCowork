import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const buildRoot = resolve(root, '.build')
const artifactsRoot = resolve(buildRoot, 'product-plugin-artifacts')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const artifactMarker = '.artifact-sha256'
const transientRenameCodes = new Set(['EBUSY', 'EACCES', 'EPERM'])

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

function directorySha256(directory) {
  const hash = createHash('sha256')
  const visit = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relativePath = `${prefix}${entry.name}`
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`)
        visit(path, `${relativePath}/`)
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`)
        hash.update(readFileSync(path))
      } else {
        throw new Error(`unsupported cached artifact entry: ${relativePath}`)
      }
    }
  }
  visit(directory, '')
  return hash.digest('hex')
}

function validateExtractedArtifact(directory, plugin, expectedSha256) {
  const markerPath = resolve(directory, artifactMarker)
  if (!existsSync(markerPath)) return false
  const packagePath = resolve(directory, 'package', 'package.json')
  if (!existsSync(packagePath)) return false
  let marker
  let packageManifest
  let packageSha256
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    packageManifest = JSON.parse(readFileSync(packagePath, 'utf8'))
    packageSha256 = directorySha256(resolve(directory, 'package'))
  } catch {
    return false
  }
  return marker.archiveSha256 === expectedSha256
    && marker.packageSha256 === packageSha256
    && packageManifest.name === (plugin.sourcePackage ?? plugin.package)
    && packageManifest.version === plugin.version
    && existsSync(resolve(directory, 'package', plugin.patch))
}

async function renameArtifactDirectory(source, destination) {
  const delays = [50, 100, 200, 400, 800, 1600, 3200]
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (cause) {
      const retry = cause !== null
        && typeof cause === 'object'
        && 'code' in cause
        && transientRenameCodes.has(cause.code)
        && attempt < delays.length
      if (!retry) throw cause
      await new Promise(resolveDelay => setTimeout(resolveDelay, delays[attempt]))
    }
  }
}

function removeGeneratedDirectory(path) {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 100,
  })
}

/**
 * 下载插件发布文件：GitHub Release 下载偶尔回 5xx 或连接中断（v0.7.12 构建两次在这里 HTTP 504，同一地址随后可下载）。
 * 只对 5xx、429 与网络错误重试，等待 5、15、30 秒，最多 4 次；4xx（地址或权限错）立即失败。下载内容仍由调用方按 SHA-256 核对。
 * @param {string} url
 * @param {string} id 插件 id，用于报错
 * @param {{ fetchImpl?: typeof fetch, delays?: number[], log?: (line: string) => void }} [options]
 * @returns {Promise<Buffer>}
 */
export async function downloadWithRetry(url, id, { fetchImpl = fetch, delays = [5000, 15000, 30000], log = line => process.stdout.write(`${line}\n`) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let reason
    try {
      const response = await fetchImpl(url, { redirect: 'follow' })
      if (response.ok) return Buffer.from(await response.arrayBuffer())
      if (response.status < 500 && response.status !== 429) fail(`${id} artifact download returned HTTP ${response.status}`)
      reason = `HTTP ${response.status}`
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('fetch-product-plugin-artifacts:')) throw error
      reason = error?.cause?.code ?? error?.name ?? String(error)
    }
    if (attempt >= delays.length) fail(`${id} artifact download returned ${reason} after ${attempt + 1} attempts`)
    log(`fetch-product-plugin-artifacts: ${id} download ${reason}; retrying in ${delays[attempt] / 1000}s (${attempt + 2}/${delays.length + 1})`)
    await new Promise(resolve => setTimeout(resolve, delays[attempt]))
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
    archive = await downloadWithRetry(artifact.url, plugin.id)
  }
  const actualSha256 = sha256(archive)
  if (actualSha256 !== artifact.sha256) {
    fail(`${plugin.id} artifact SHA-256 mismatch: expected ${artifact.sha256}, got ${actualSha256}`)
  }
  if (!existsSync(archivePath)) writeFileSync(archivePath, archive)
  validateArchive(archivePath, plugin.id)

  const destination = resolve(artifactsRoot, plugin.id)
  if (validateExtractedArtifact(destination, plugin, actualSha256)) {
    process.stdout.write(`fetch-product-plugin-artifacts: ${plugin.id}@${plugin.version} ${actualSha256}\n`)
    return
  }
  const temporary = resolve(artifactsRoot, `.${plugin.id}-${process.pid}`)
  removeGeneratedDirectory(temporary)
  try {
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
    writeFileSync(resolve(temporary, artifactMarker), `${JSON.stringify({
      archiveSha256: actualSha256,
      packageSha256: directorySha256(resolve(temporary, 'package')),
    }, undefined, 2)}\n`)

    removeGeneratedDirectory(destination)
    await renameArtifactDirectory(temporary, destination)
  } finally {
    removeGeneratedDirectory(temporary)
  }
  process.stdout.write(`fetch-product-plugin-artifacts: ${plugin.id}@${plugin.version} ${actualSha256}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  for (const plugin of product.plugins.filter(item => item.enabledByDefault === true && item.artifact !== undefined)) {
    await downloadArtifact(plugin)
  }
}
