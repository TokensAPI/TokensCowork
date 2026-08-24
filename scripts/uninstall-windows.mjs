#!/usr/bin/env node

/**
 * Windows 静默卸载。
 *
 * NSIS 卸载器启动时会把自身复制到 %TEMP% 再从那里运行，好让它能删掉自己所在
 * 的目录。副本的 $INSTDIR 是空的，于是 `RMDir /r $INSTDIR` 无事可做，流程却
 * 照常走完并返回 0 —— 直接 `Uninstall.exe /S` 报成功但什么都没卸掉，根源在此。
 *
 * `_?=<dir>` 让卸载器就地运行并把 $INSTDIR 钉到真实安装路径，是 NSIS 提供的
 * 唯一正解；electron-builder 自升级时也这么调（app-builder-lib 的
 * templates/nsis/include/installUtil.nsh）。两条硬性约束：该参数必须排在最后，
 * 且路径不能加引号。
 *
 * 就地运行的代价是卸载器不再自删，所以调用方要自己收尾。又因为退出码在本缺陷
 * 里恰恰是不可信的那一环，卸载完成与否一律以文件系统为准。
 *
 * 卸载默认保留用户数据，要清除得显式加 --purge-data。这与打包侧一致：
 * build/assembly/configure.mjs 不写 deleteAppDataOnUninstall，两处校验脚本还会
 * 拦下它变回 true——那是个编译期开关，一旦打进安装包，运行期再也关不掉。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 产品在 HKCU 卸载表中的键名，由 electron-builder 按 appId 生成。 */
export const UNINSTALL_REGISTRY_KEY
  = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.tokensapi.tokensharness'

/** 允许卸载器占用的时长上限，超时按失败处理而不是无限等待。 */
const UNINSTALL_TIMEOUT_MS = 5 * 60 * 1000

/* ====================================================================
 * 卸载命令行的拼装（导出）
 * `_?=` 的两条约束（末位、无引号）无法从退出码上观察到，写错了只会
 * 静默退化成"复制到临时目录"的老毛病。抽成纯函数以便直接断言。
 * ==================================================================== */

/**
 * 拼出静默卸载的参数表。
 *
 * 卸载器只解析 `--delete-app-data`（templates/nsis/uninstaller.nsh）。electron-builder
 * 自升级时传的 `/KEEP_APP_DATA` 没有任何解析分支，纯属摆设——保留数据靠的是不传
 * `--delete-app-data`，且构建时不定义 DELETE_APP_DATA_ON_UNINSTALL。本产品两者都满足，
 * 所以默认什么都不传就是保留。
 *
 * @param {string} installDirectory 真实安装目录的绝对路径。
 * @param {{ deleteAppData?: boolean }} [options] `deleteAppData` 让卸载器一并删除用户数据。
 * @returns {string[]} 传给卸载器的参数，`_?=` 保证在末位。
 */
export function buildUninstallArguments(installDirectory, options = {}) {
  if (typeof installDirectory !== 'string' || installDirectory.trim() === '') {
    throw new Error('uninstall-windows: install directory is required')
  }
  const args = ['/S']
  if (options.deleteAppData === true) args.push('--delete-app-data')
  // NSIS 只认末位的 _?=，且自带路径解析——加引号会被当成路径的一部分。
  args.push(`_?=${resolve(installDirectory)}`)
  return args
}

/**
 * 判断卸载是否真的完成。
 *
 * 退出码在本缺陷里正是失灵的那一环，故只看文件系统：目录没了算成功，
 * 只剩卸载器自身（就地运行的既定残留）也算成功。
 *
 * @param {string[]} remainingEntries 安装目录下剩余的条目名，目录不存在时传空数组。
 * @param {boolean} directoryExists 安装目录是否仍存在。
 * @returns {boolean} 卸载是否达成。
 */
export function isUninstallComplete(remainingEntries, directoryExists) {
  if (!directoryExists) return true
  return remainingEntries.every(entry => /^Uninstall.*\.exe$/iu.test(entry))
}

/* ====================================================================
 * 注册表查询
 * ==================================================================== */

/**
 * 从 HKCU 读取产品的安装信息。
 *
 * perMachine 为 false，条目落在 HKCU 而非 HKLM。
 *
 * @returns {{ installLocation: string, uninstallString: string } | null} 未安装时为 null。
 */
function readInstallInfo() {
  const script = `
    $ErrorActionPreference = 'Stop'
    if (-not (Test-Path '${UNINSTALL_REGISTRY_KEY}')) { exit 3 }
    $k = Get-ItemProperty '${UNINSTALL_REGISTRY_KEY}'
    [Console]::Out.Write(($k.InstallLocation, $k.UninstallString) -join "\`n")
  `
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  )
  if (result.status === 3) return null
  if (result.status !== 0) {
    throw new Error(`uninstall-windows: registry query failed: ${result.stderr.trim()}`)
  }
  const [installLocation, uninstallString] = result.stdout.split('\n').map(line => line.trim())
  if (!installLocation || !uninstallString) return null
  // UninstallString 带引号，execFile 要的是裸路径。
  return { installLocation, uninstallString: uninstallString.replace(/^"|"$/gu, '') }
}

/* ====================================================================
 * 主流程
 * ==================================================================== */

/**
 * 执行静默卸载并按文件系统核实结果。
 *
 * @param {{ purgeData?: boolean }} [options] `purgeData` 一并清除 %APPDATA% 下的产品数据。
 * @returns {{ status: string, detail: string }} 结果与说明。
 */
export function uninstall(options = {}) {
  const info = readInstallInfo()
  if (info === null) return { status: 'not-installed', detail: '注册表中没有安装记录' }

  const { installLocation, uninstallString } = info
  if (!existsSync(uninstallString)) {
    return { status: 'stale-registry', detail: `卸载器不存在：${uninstallString}` }
  }

  // 默认保留用户数据：不传 --delete-app-data，卸载器就不碰 %APPDATA%。
  const args = buildUninstallArguments(installLocation, { deleteAppData: options.purgeData === true })
  const result = spawnSync(uninstallString, args, {
    encoding: 'utf8',
    timeout: UNINSTALL_TIMEOUT_MS,
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    throw new Error(`uninstall-windows: 卸载器启动失败：${result.error.message}`)
  }

  const directoryExists = existsSync(installLocation)
  const remaining = directoryExists ? readdirSync(installLocation) : []
  if (!isUninstallComplete(remaining, directoryExists)) {
    // 退出码在此缺陷中不可信，以文件系统为准并把它一并报出来供排查。
    throw new Error(
      `uninstall-windows: 卸载未完成（退出码 ${String(result.status)}），`
      + `${installLocation} 仍有 ${String(remaining.length)} 项：${remaining.slice(0, 5).join(', ')}`,
    )
  }

  // 就地运行的卸载器不会自删，安装目录也就空着，这里收尾。
  if (directoryExists) rmSync(installLocation, { recursive: true, force: true })

  const cleaned = ['安装目录']
  if (options.purgeData === true) {
    const appData = process.env.APPDATA
    if (typeof appData === 'string' && appData.trim() !== '') {
      const dataDirectory = join(appData, 'TokensHarness')
      if (existsSync(dataDirectory) && statSync(dataDirectory).isDirectory()) {
        rmSync(dataDirectory, { recursive: true, force: true })
        cleaned.push('用户数据')
      }
    }
  }
  return { status: 'uninstalled', detail: `已清除：${cleaned.join('、')}` }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  if (process.platform !== 'win32') {
    console.error('uninstall-windows: 仅适用于 Windows')
    process.exit(1)
  }
  const purgeData = process.argv.includes('--purge-data')
  const { status, detail } = uninstall({ purgeData })
  process.stdout.write(`uninstall-windows: ${status} — ${detail}\n`)
  if (status === 'stale-registry') process.exit(1)
}
