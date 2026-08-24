import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const canonicalVersion = readFileSync(resolve(root, 'VERSION'), 'utf8').trim()
const fail = message => { throw new Error(`verify-layout: ${message}`) }
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

function assertPackagePath(path, label) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) {
    fail(`${label} must be a non-empty relative path`)
  }
  const segments = path.replaceAll('\\', '/').split('/')
  if (segments.includes('..') || segments.includes('.') || segments.includes('')) {
    fail(`${label} must stay inside its package`)
  }
}

function containsExportTarget(value, target) {
  if (typeof value === 'string') return value === target
  if (value === null || typeof value !== 'object') return false
  return Object.values(value).some(entry => containsExportTarget(entry, target))
}

function containsTypescriptExport(value) {
  if (typeof value === 'string') return /\.tsx?$/u.test(value) && !/\.d\.tsx?$/u.test(value)
  if (value === null || typeof value !== 'object') return false
  return Object.values(value).some(containsTypescriptExport)
}

function assertGitlink(path, commit) {
  const [mode, object] = git(root, 'ls-files', '--stage', '--', path).split(/\s+/u)
  if (mode !== '160000' || object !== commit) {
    fail(`${path} gitlink differs from product.json`)
  }
}

if (manifest.schemaVersion !== 1) fail('product.json must use schemaVersion 1')
if (manifest.product?.name !== 'TokensHarness') fail('product name must be TokensHarness')
if (typeof manifest.product?.appId !== 'string' || manifest.product.appId.length === 0) {
  fail('product appId must be a non-empty string')
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(canonicalVersion)) {
  fail('VERSION must contain a valid product version')
}
if (manifest.product.version !== canonicalVersion || packageManifest.version !== canonicalVersion) {
  fail('VERSION, product.json, and package.json versions must match')
}

const desktopPath = resolve(root, manifest.desktop.path)
assertGitlink(manifest.desktop.path, manifest.desktop.commit)
if (git(root, 'config', '-f', '.gitmodules', '--get', 'submodule.desktop.url')
  !== manifest.desktop.repository) {
  fail('desktop submodule URL differs from product.json')
}
if (!existsSync(desktopPath)) fail('desktop submodule is not initialized')
if (git(desktopPath, 'rev-parse', 'HEAD') !== manifest.desktop.commit) {
  fail('desktop checkout differs from product.json')
}
if (git(desktopPath, 'status', '--porcelain') !== '') fail('desktop submodule contains local changes')

const harnessPath = resolve(desktopPath, 'deepseek-harness')
if (!existsSync(harnessPath)) fail('nested deepseek-harness submodule is not initialized')
if (git(harnessPath, 'rev-parse', 'HEAD') !== manifest.desktop.deepseekHarnessCommit) {
  fail('nested deepseek-harness checkout differs from product.json')
}
if (git(harnessPath, 'status', '--porcelain') !== '') {
  fail('nested deepseek-harness submodule contains local changes')
}

for (const plugin of manifest.plugins) {
  const pluginPath = resolve(root, plugin.path)
  assertGitlink(plugin.path, plugin.commit)
  if (git(root, 'config', '-f', '.gitmodules', '--get', `submodule.${plugin.id}.url`)
    !== plugin.repository) {
    fail(`${plugin.id} submodule URL differs from product.json`)
  }
  if (!existsSync(pluginPath)) fail(`${plugin.id} submodule is not initialized`)
  if (git(pluginPath, 'rev-parse', 'HEAD') !== plugin.commit) {
    fail(`${plugin.id} checkout differs from product.json`)
  }
  if (git(pluginPath, 'status', '--porcelain') !== '') {
    fail(`${plugin.id} submodule contains local changes`)
  }
  const pluginManifest = JSON.parse(readFileSync(resolve(pluginPath, 'package.json'), 'utf8'))
  if (pluginManifest.name !== (plugin.sourcePackage ?? plugin.package)
    || pluginManifest.version !== plugin.version) {
    fail(`${plugin.id} package identity differs from product.json`)
  }
  if (plugin.enabledByDefault === true && !existsSync(resolve(pluginPath, plugin.patch))) {
    fail(`${plugin.id} is enabled but its bundle patch is missing`)
  }
  const runtimeBuild = plugin.runtimeBuild
  if (runtimeBuild !== undefined) {
    if (runtimeBuild.type !== 'typescript') fail(`${plugin.id} runtimeBuild type is unsupported`)
    assertPackagePath(runtimeBuild.entry, `${plugin.id} runtimeBuild entry`)
    assertPackagePath(runtimeBuild.output, `${plugin.id} runtimeBuild output`)
    if (!runtimeBuild.entry.endsWith('.ts') || !runtimeBuild.output.endsWith('.js')) {
      fail(`${plugin.id} runtimeBuild must compile a .ts entry to a .js output`)
    }
    if (!existsSync(resolve(pluginPath, runtimeBuild.entry))) {
      fail(`${plugin.id} runtimeBuild entry is missing`)
    }
    if (!containsExportTarget(pluginManifest.exports, `./${runtimeBuild.entry}`)) {
      fail(`${plugin.id} package exports do not reference its runtimeBuild entry`)
    }
    if (!Array.isArray(runtimeBuild.files) || runtimeBuild.files.length === 0) {
      fail(`${plugin.id} runtimeBuild files must be a non-empty list`)
    }
    for (const entry of runtimeBuild.files) assertPackagePath(entry, `${plugin.id} runtimeBuild files entry`)
  } else if (plugin.enabledByDefault === true && containsTypescriptExport(pluginManifest.exports)) {
    fail(`${plugin.id} exposes a TypeScript runtime entry without runtimeBuild`)
  }
  if (plugin.artifact !== undefined) {
    if (plugin.artifact.type !== 'npm-tgz'
      || typeof plugin.artifact.url !== 'string'
      || !plugin.artifact.url.startsWith('https://')
      || !/^[0-9a-f]{64}$/u.test(plugin.artifact.sha256 ?? '')) {
      fail(`${plugin.id} release artifact declaration is invalid`)
    }
  }
}

if (manifest.plugins.some(plugin => plugin.enabledByDefault === true)
  && !existsSync(resolve(root, 'build', 'product.yarn.lock'))) {
  fail('enabled product plugins require build/product.yarn.lock; run product:refresh-lock')
}

process.stdout.write(
  `verify-layout: ${manifest.product.name} ${canonicalVersion}, desktop ${manifest.desktop.commit.slice(0, 10)}, Harness ${manifest.desktop.deepseekHarnessCommit.slice(0, 10)}, ${manifest.plugins.length} plugin submodule(s)\n`,
)
