import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

/* ====================================================================
 * 路径与产品清单
 * 仓库根、staging 目录、desktop 子模块源目录，以及从 product.json
 * 读出的产品清单和默认启用的插件列表。
 * ==================================================================== */

const root = resolve(import.meta.dirname, '..')
const stageRoot = resolve(root, '.build')
const stage = resolve(stageRoot, 'desktop')
const desktopSource = resolve(root, 'desktop')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const enabledPlugins = manifest.plugins.filter(item => item.enabledByDefault === true)

/* ====================================================================
 * 工具函数
 * 仅供本脚本使用的辅助函数；新增的独立加工逻辑（改副本、加覆盖等）
 * 写成函数放在本区，再到主流程对应步骤中调用。
 * ==================================================================== */

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

/**
 * 追加停用上游 desktop-updates 插件的覆盖条目，阻止官方 DSH Desktop 更新推送覆盖本产品。
 * @param patch - staging 副本中 cordis.patch.yml 的完整内容。
 * @returns 追加停用覆盖条目后的补丁内容。
 * @throws 上游 desktop-updates 注册条目与锚点不一致时抛出，中断打包待人工复查。
 */
function disableUpstreamUpdates(patch) {
  const upstreamEntry = '    - id: desktop-updates\n      name: dsh-plugin-desktop/updates'
  if (!patch.includes(upstreamEntry)) {
    throw new Error('prepare-desktop: 未找到上游 desktop-updates 注册条目，请复查更新覆盖配置')
  }
  return `${patch}\n\n# 产品覆盖：上游更新服务指向官方 DSH Desktop，与本产品无关，予以停用。\n`
    + '- id: desktop-updates\n  disabled: true'
}

/* ====================================================================
 * 主流程
 * 按顺序执行 staging 装配：重建目录、读入副本、各项产品加工、写回。
 * 以后新增的产品化操作按性质插入对应步骤之间，并加同款分节横幅。
 * ==================================================================== */

/* ------------------------ 重建 staging 目录 ------------------------- */
mkdirSync(stageRoot, { recursive: true })
assertGeneratedPath(stage)
if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
copySource(desktopSource, stage)
cpSync(
  resolve(root, 'build', 'mac-unsigned-after-pack.ts'),
  resolve(stage, 'dsh-plugin-desktop', 'scripts', 'mac-unsigned-after-pack.ts'),
)

/* ----------------------- 读入待改写的副本文件 ----------------------- */
const workspacePath = resolve(stage, 'package.json')
const desktopPackagePath = resolve(stage, 'dsh-plugin-desktop', 'package.json')
const desktopPatchPath = resolve(stage, 'dsh-plugin-desktop', 'cordis.patch.yml')
const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
let desktopPatch = readFileSync(desktopPatchPath, 'utf8').trimEnd()

/* ------------------------- 停用上游自动更新 ------------------------- */
desktopPatch = disableUpstreamUpdates(desktopPatch)

/* --------------------------- 注入产品插件 --------------------------- */
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

/* --------------------------- 写回改写结果 --------------------------- */
writeFileSync(workspacePath, `${JSON.stringify(workspace, undefined, 2)}\n`)
writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
writeFileSync(desktopPatchPath, `${desktopPatch}\n`)

/* -------------------------- 安装产品锁文件 -------------------------- */
if (enabledPlugins.length > 0) {
  const productLock = resolve(root, 'build', 'product.yarn.lock')
  if (existsSync(productLock)) {
    cpSync(productLock, resolve(stage, 'yarn.lock'))
  } else if (process.env.PRODUCT_REFRESH_LOCK !== '1') {
    throw new Error('prepare-desktop: enabled plugins require build/product.yarn.lock; run product:refresh-lock')
  }
}

/* --------------------------- 输出装配摘要 --------------------------- */
process.stdout.write(
  `prepare-desktop: staged ${manifest.product.name} ${manifest.product.version} from ${manifest.desktop.commit.slice(0, 10)} with ${enabledPlugins.length} default plugin(s) at ${stage}\n`,
)
