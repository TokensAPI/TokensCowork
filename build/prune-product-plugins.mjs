import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stage = resolve(root, '.build', 'desktop')
const pluginsRoot = resolve(stage, 'dsh-plugin-desktop', 'product-plugins')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))

function fail(message) {
  throw new Error(`prune-product-plugins: ${message}`)
}

function assertLiteralPackageEntry(entry, pluginId) {
  if (typeof entry !== 'string' || entry.length === 0) fail(`${pluginId} contains an invalid files entry`)
  if (/[*?{}[\]!]/u.test(entry)) fail(`${pluginId} files entry must be a literal path: ${entry}`)

  const normalized = entry.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    fail(`${pluginId} files entry escapes its package: ${entry}`)
  }
  return normalized
}

function copyEntry(sourceRoot, destinationRoot, entry, pluginId) {
  const source = resolve(sourceRoot, entry)
  const destination = resolve(destinationRoot, entry)
  if (relative(sourceRoot, source).startsWith(`..${sep}`) || relative(destinationRoot, destination).startsWith(`..${sep}`)) {
    fail(`${pluginId} files entry escaped its package: ${entry}`)
  }
  if (!existsSync(source)) fail(`${pluginId} runtime file is missing after build: ${entry}`)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true })
}

function removeSourceMaps(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) removeSourceMaps(path)
    else if (entry.name.endsWith('.map')) rmSync(path, { force: true })
  }
}

for (const plugin of product.plugins.filter(
  item => item.enabledByDefault === true && item.artifact !== undefined,
)) {
  const source = resolve(pluginsRoot, plugin.id)
  const manifestPath = resolve(source, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${plugin.id} must declare a non-empty package.json files list`)
  }

  const temporary = resolve(pluginsRoot, `.${plugin.id}.runtime-${process.pid}`)
  rmSync(temporary, { recursive: true, force: true })

  const entries = new Set(manifest.files.map(entry => assertLiteralPackageEntry(entry, plugin.id)))
  for (const name of readdirSync(source)) {
    if (/^(?:readme|licen[cs]e|notice)(?:[.-].*)?$/iu.test(name)) entries.add(name)
  }
  for (const entry of entries) copyEntry(source, temporary, entry, plugin.id)
  removeSourceMaps(temporary)

  delete manifest.devDependencies
  delete manifest.scripts
  delete manifest.allowScripts
  delete manifest.packageManager
  writeFileSync(resolve(temporary, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

  for (const name of readdirSync(source)) {
    if (name === 'node_modules') continue
    rmSync(resolve(source, name), { recursive: true, force: true })
  }
  cpSync(temporary, source, { recursive: true })
  rmSync(temporary, { recursive: true, force: true })
  process.stdout.write(`prune-product-plugins: ${plugin.id} kept ${entries.size} runtime entry(s)\n`)
}
