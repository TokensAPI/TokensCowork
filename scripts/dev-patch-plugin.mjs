/* ============================================================
 * 内置插件热替换（开发用）
 * ============================================================
 * 把本地插件子模块的当前代码直接覆盖进已安装的 TokensCowork，
 * 跳过完整打包流程，重启应用即加载新代码。仅供本机开发迭代；
 * 测试完成后重新运行正式安装器即可回归发行版文件。
 *
 * 用法：
 *   node scripts/dev-patch-plugin.mjs <插件id>            # 替换
 *   node scripts/dev-patch-plugin.mjs <插件id> --restore  # 从备份还原
 *   node scripts/dev-patch-plugin.mjs --list              # 列出可用插件
 *
 * 行为：
 *   1. 按 product.json 找到插件登记；声明 runtimeBuild 的插件先在
 *      子模块里跑构建（产物必须齐全才继续）。
 *   2. 定位已安装应用（注册表 InstallLocation → 默认路径回退）里
 *      该插件的运行时目录。
 *   3. 首次替换先把安装内原目录备份为 <目录>.dev-backup（已存在
 *      则不重复备份，保证备份始终是发行版）。
 *   4. 复制子模块的运行时文件覆盖安装内目录（跳过 node_modules、
 *      .git、测试与源码目录——只带运行时需要的文件）。
 *   5. 提示重启应用。--restore 用备份还原并删除备份。
 * ============================================================ */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8'))
const productName = manifest.product.name

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--list') {
  process.stdout.write('可热替换的内置插件：\n')
  for (const plugin of manifest.plugins.filter(item => item.enabledByDefault === true)) {
    const note = plugin.artifact !== undefined
      ? '（制品型：以子模块工作区当前产物替换，请确认已在子模块内构建）'
      : plugin.runtimeBuild?.script !== undefined
        ? `（先执行子模块 ${plugin.runtimeBuild.script} 构建）`
        : '（直接复制运行时文件）'
    process.stdout.write(`  ${plugin.id}  ${note}\n`)
  }
  process.exit(0)
}
const pluginId = args[0]
const restore = args.includes('--restore')
const plugin = manifest.plugins.find(item => item.id === pluginId && item.enabledByDefault === true)
if (plugin === undefined) {
  throw new Error(`dev-patch-plugin: 未找到默认启用的插件 "${pluginId}"（--list 查看可用项）`)
}

/* --------------------------- 定位已装应用 --------------------------- */

function installedRoot() {
  // 注册表 InstallLocation 优先；缺失时回退默认 per-user 安装路径。
  const guid = manifest.product.windowsInstallerGuid
  if (guid !== undefined) {
    const query = spawnSync('reg', [
      'query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
      '/v', 'InstallLocation',
    ], { encoding: 'utf8' })
    const match = /InstallLocation\s+REG_SZ\s+(.+)/u.exec(query.stdout ?? '')
    const fromRegistry = match?.[1]?.trim()
    if (fromRegistry !== undefined && fromRegistry !== '' && existsSync(fromRegistry)) return fromRegistry
  }
  const fallback = join(
    process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
    'Programs', productName,
  )
  if (existsSync(fallback)) return fallback
  throw new Error(`dev-patch-plugin: 未找到已安装的 ${productName}；请先安装正式包`)
}

const appRoot = installedRoot()
const installedPluginDir = join(
  appRoot, 'resources', 'app.asar.unpacked', 'node_modules', ...plugin.package.split('/'),
)
if (!existsSync(installedPluginDir) && !existsSync(`${installedPluginDir}.dev-backup`)) {
  throw new Error(`dev-patch-plugin: 安装目录中未找到插件运行时：${installedPluginDir}`)
}
const backupDir = `${installedPluginDir}.dev-backup`

/* ------------------------------ 还原 ------------------------------ */

if (restore) {
  if (!existsSync(backupDir)) {
    throw new Error('dev-patch-plugin: 没有备份可还原（该插件未被替换过）')
  }
  rmSync(installedPluginDir, { recursive: true, force: true })
  renameSync(backupDir, installedPluginDir)
  process.stdout.write(`dev-patch-plugin: 已还原发行版 ${plugin.package}；重启 ${productName} 生效\n`)
  process.exit(0)
}

/* --------------------------- 构建（如声明） --------------------------- */

const sourceDir = resolve(root, plugin.path)
if (!existsSync(sourceDir)) {
  throw new Error(`dev-patch-plugin: 插件子模块不存在：${sourceDir}（先 git submodule update --init）`)
}
if (plugin.runtimeBuild?.script !== undefined) {
  process.stdout.write(`dev-patch-plugin: 在子模块中执行 ${plugin.runtimeBuild.script}...\n`)
  const build = spawnSync('npm', ['run', plugin.runtimeBuild.script], {
    cwd: sourceDir, encoding: 'utf8', shell: true, stdio: 'inherit',
  })
  if (build.status !== 0) throw new Error('dev-patch-plugin: 插件构建失败，终止替换')
  for (const output of plugin.runtimeBuild.outputs ?? []) {
    if (!existsSync(resolve(sourceDir, output))) {
      throw new Error(`dev-patch-plugin: 构建产物缺失：${output}`)
    }
  }
}

/* --------------------------- 备份并覆盖 --------------------------- */

// 备份只做一次：首次替换时留住发行版，此后反复替换不再覆盖备份。
if (!existsSync(backupDir) && existsSync(installedPluginDir)) {
  renameSync(installedPluginDir, backupDir)
  process.stdout.write(`dev-patch-plugin: 发行版已备份至 ${basename(backupDir)}\n`)
} else if (existsSync(installedPluginDir)) {
  rmSync(installedPluginDir, { recursive: true, force: true })
}

// 只带运行时需要的文件；源码、依赖、版本控制与测试目录不进安装目录。
const SKIP = new Set(['node_modules', '.git', 'test', 'tests', 'src', 'scripts'])
cpSync(sourceDir, installedPluginDir, {
  recursive: true,
  filter: candidate => !SKIP.has(basename(candidate)),
})

process.stdout.write(
  `dev-patch-plugin: 已用本地代码替换 ${plugin.package}\n`
  + `  来源  ${sourceDir}\n`
  + `  目标  ${installedPluginDir}\n`
  + `重启 ${productName} 生效；还原请执行：node scripts/dev-patch-plugin.mjs ${pluginId} --restore\n`,
)
