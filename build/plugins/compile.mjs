import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const stage = resolve(root, '.build', 'desktop')
const desktopPackageRoot = resolve(stage, 'dsh-plugin-desktop')
const pluginsRoot = resolve(desktopPackageRoot, 'product-plugins')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))

function fail(message) {
  throw new Error(`compile-product-plugins: ${message}`)
}

function packagePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) {
    fail(`${label} must be a non-empty relative path`)
  }
  const normalized = value.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (segments.includes('..') || segments.includes('.') || segments.includes('')) {
    fail(`${label} must stay inside its package`)
  }
  return normalized
}

function quoteCmdArgument(value) {
  if (/^[A-Za-z0-9:._@/=-]+$/u.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

function run(command, args, cwd) {
  const windowsCorepack = process.platform === 'win32' && command === 'corepack'
  const executable = windowsCorepack
    ? process.env.ComSpec ?? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    : command
  const resolvedArgs = windowsCorepack
    ? ['/d', '/s', '/c', `corepack ${args.map(quoteCmdArgument).join(' ')}`]
    : args
  const result = spawnSync(executable, resolvedArgs, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

function rewriteExportTarget(value, source, output) {
  if (typeof value === 'string') return { value: value === source ? output : value, count: value === source ? 1 : 0 }
  if (value === null || typeof value !== 'object') return { value, count: 0 }

  let count = 0
  const rewritten = {}
  for (const [key, entry] of Object.entries(value)) {
    const result = rewriteExportTarget(entry, source, output)
    rewritten[key] = result.value
    count += result.count
  }
  return { value: rewritten, count }
}

function assertOutputFiles(plugin, outputs, pluginRoot) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    fail(`${plugin.id} runtimeBuild outputs must be a non-empty list`)
  }
  for (const entry of outputs) {
    const output = packagePath(entry, `${plugin.id} runtimeBuild output`)
    if (!existsSync(resolve(pluginRoot, output))) {
      fail(`${plugin.id} build did not produce ${output}`)
    }
  }
}

function runPackageBuild(plugin, build, pluginRoot) {
  if (typeof build.script !== 'string' || !/^[A-Za-z0-9:_-]+$/u.test(build.script)) {
    fail(`${plugin.id} runtimeBuild script must be a package script name`)
  }
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'))
  if (typeof manifest.scripts?.[build.script] !== 'string') {
    fail(`${plugin.id} package does not define the ${build.script} script`)
  }
  run('corepack', ['yarn', 'workspace', plugin.package, 'run', build.script], stage)
  assertOutputFiles(plugin, build.outputs, pluginRoot)
  process.stdout.write(`compile-product-plugins: ${plugin.id} ran ${build.script}\n`)
}

function runLegacyTypescriptBuild(plugin, build, pluginRoot) {
  if (!Array.isArray(build.files) || build.files.length === 0) {
    fail(`${plugin.id} runtimeBuild files must be a non-empty list`)
  }

  const entry = packagePath(build.entry, `${plugin.id} entry`)
  const output = packagePath(build.output, `${plugin.id} output`)
  const files = build.files.map(item => packagePath(item, `${plugin.id} files entry`))
  const entryPath = resolve(pluginRoot, entry)
  const outputPath = resolve(pluginRoot, output)
  if (!existsSync(entryPath)) fail(`${plugin.id} entry is missing: ${entry}`)

  const sourceRoot = resolve(pluginRoot, dirname(entry))
  const outputRoot = resolve(pluginRoot, dirname(output))
  const relativeEntry = relative(desktopPackageRoot, entryPath).split(sep).join('/')
  const relativeSourceRoot = relative(desktopPackageRoot, sourceRoot).split(sep).join('/')
  const relativeOutputRoot = relative(desktopPackageRoot, outputRoot).split(sep).join('/')

  run('corepack', [
    'yarn', 'workspace', 'dsh-plugin-desktop', 'exec', 'tsc',
    '--ignoreConfig',
    '--pretty', 'false',
    '--noCheck',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--rewriteRelativeImportExtensions',
    '--rootDir', relativeSourceRoot,
    '--outDir', relativeOutputRoot,
    relativeEntry,
  ], stage)

  if (!existsSync(outputPath)) fail(`${plugin.id} compiler did not produce ${output}`)

  const manifestPath = resolve(pluginRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const rewritten = rewriteExportTarget(manifest.exports, `./${entry}`, `./${output}`)
  if (rewritten.count === 0) fail(`${plugin.id} package exports do not reference ./${entry}`)
  manifest.exports = rewritten.value
  manifest.files = files
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

  process.stdout.write(`compile-product-plugins: ${plugin.id} ${entry} -> ${output} (legacy)\n`)
}

for (const plugin of product.plugins.filter(
  item => item.enabledByDefault === true && item.runtimeBuild !== undefined,
)) {
  const build = plugin.runtimeBuild
  const pluginRoot = resolve(pluginsRoot, plugin.id)
  if (build.script !== undefined) runPackageBuild(plugin, build, pluginRoot)
  else if (build.type === 'typescript') runLegacyTypescriptBuild(plugin, build, pluginRoot)
  else fail(`${plugin.id} runtimeBuild declaration is unsupported`)
}
