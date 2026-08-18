import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stageRoot = resolve(root, '.build')
const stage = resolve(stageRoot, 'desktop')
const desktopSource = resolve(root, 'desktop')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const enabledPlugins = manifest.plugins.filter(item => item.enabledByDefault === true)

function assertGeneratedPath(path) {
  if (path !== stage && !path.startsWith(`${stage}${sep}`)) {
    throw new Error(`prepare-desktop: generated path escaped staging: ${path}`)
  }
}

function copySource(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter: candidate => {
      const name = basename(candidate)
      return name !== '.git' && name !== 'node_modules' && name !== 'dist'
        && !(candidate === resolve(desktopSource, 'deepseek-harness'))
    },
  })
}

mkdirSync(stageRoot, { recursive: true })
assertGeneratedPath(stage)
if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
copySource(desktopSource, stage)

const workspacePath = resolve(stage, 'package.json')
const desktopPackagePath = resolve(stage, 'dsh-plugin-desktop', 'package.json')
const desktopPatchPath = resolve(stage, 'dsh-plugin-desktop', 'cordis.patch.yml')
const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
let desktopPatch = readFileSync(desktopPatchPath, 'utf8').trimEnd()

for (const plugin of enabledPlugins) {
  const source = resolve(root, plugin.path)
  const destination = resolve(stage, 'product-plugins', plugin.id)
  assertGeneratedPath(destination)
  mkdirSync(resolve(destination, '..'), { recursive: true })
  copySource(source, destination)

  const workspaceEntry = relative(stage, destination).split(sep).join('/')
  if (!workspace.workspaces.includes(workspaceEntry)) workspace.workspaces.push(workspaceEntry)
  desktopPackage.dependencies[plugin.package] = 'workspace:*'
  for (const [name, version] of Object.entries(plugin.runtimeDependencies ?? {})) {
    desktopPackage.dependencies[name] = version
    if (desktopPackage.devDependencies?.[name] !== undefined) delete desktopPackage.devDependencies[name]
  }

  const pluginPatch = readFileSync(resolve(source, plugin.patch), 'utf8').trim()
  desktopPatch += `\n\n# Product plugin: ${plugin.id}\n${pluginPatch}`
}

writeFileSync(workspacePath, `${JSON.stringify(workspace, undefined, 2)}\n`)
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(desktopPatchPath, `${desktopPatch}\n`)

if (enabledPlugins.length > 0) {
  const productLock = resolve(root, 'build', 'product.yarn.lock')
  if (existsSync(productLock)) {
    cpSync(productLock, resolve(stage, 'yarn.lock'))
  } else if (process.env.PRODUCT_REFRESH_LOCK !== '1') {
    throw new Error('prepare-desktop: enabled plugins require build/product.yarn.lock; run product:refresh-lock')
  }
}

process.stdout.write(
  `prepare-desktop: staged ${manifest.desktop.commit.slice(0, 10)} with ${enabledPlugins.length} default plugin(s) at ${stage}\n`,
)
