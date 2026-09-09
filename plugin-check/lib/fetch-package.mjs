/* ============================================================
 * 已发布包获取:npm pack 指定 spec 并解包,供市场门禁按
 * "包名@版本"体检(而不是本地目录)。
 * ============================================================ */
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNpm } from './npm.mjs'

const FETCH_TIMEOUT_MS = 180_000

/**
 * 拉取并解包一个已发布的 npm 包。
 * @param {string} spec - 如 "@scope/name@1.2.3"(建议锁定精确版本)。
 * @returns {{ dir: string } | { error: string }} dir 为解出的包根目录
 *   (临时位置,由调用方决定何时清理)。
 */
export function fetchPackage(spec) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-plugin-fetch-'))
  const pack = runNpm(['pack', spec, '--pack-destination', workspace], workspace, FETCH_TIMEOUT_MS)
  if (pack.status !== 0) {
    return { error: `npm pack ${spec} 失败: ${(pack.stderr || pack.stdout || '').trim().split('\n').slice(-3).join(' ')}` }
  }
  const tarball = readdirSync(workspace).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) return { error: 'npm pack 未产出 tgz' }
  const extractDir = join(workspace, 'extracted')
  mkdirSync(extractDir)
  // Windows 自带 bsdtar,macOS/Linux 自带 tar;相对路径调用避开
  // MSYS tar 对盘符路径的误判。
  const extract = spawnSync('tar', ['-xzf', tarball, '-C', 'extracted'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: FETCH_TIMEOUT_MS,
    shell: process.platform === 'win32',
  })
  if (extract.status !== 0) {
    return { error: `解包失败: ${(extract.stderr || '').trim().split('\n').slice(-2).join(' ')}` }
  }
  // npm 打包约定顶层目录名为 package/。
  const [root] = readdirSync(extractDir)
  if (root === undefined) return { error: '解包结果为空' }
  return { dir: join(extractDir, root) }
}
