// MSIX（商店包）对文件名比 NTFS 严：MakeAppx 遇到下面这些名字整包失败（0x8007007B，且不说是哪个文件）。
//   node build/pipeline/store-payload-scan.mjs <目录>                      只扫描，列出不合规路径
//   node build/pipeline/store-payload-scan.mjs --prepare <程序目录> <输出目录>
//     复制一份程序目录给商店包用，删掉 PRUNE 里已知用不到的不合规文件，再扫描；还有不合规的就失败并列出全部。
//     EXE 用的程序目录不动。
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** Windows 保留设备名：带不带扩展名都不行（aux.py、nul.txt 同样非法）。 */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/iu
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"|?*\u0000-\u001f]/u

/**
 * 商店包里删掉的文件：已确认程序运行时不读，只是因为名字不合 MSIX 规矩。路径相对程序目录。
 * 新增条目必须写清楚为什么用不到。
 */
export const PRUNE = [
  {
    path: 'resources/runtime/x64/primary-runtime/dependencies/python/Lib/site-packages/docx/templates/default-docx-template',
    why: 'python-docx 打包时留下的 default.docx 解压源（含 [Content_Types].xml）；运行时只读 templates/default.docx（docx/api.py）。',
  },
]

/** 一个文件或目录名在 MSIX 里为什么不合规；合规返回 null。 */
export function invalidReason(name) {
  if (RESERVED.test(name)) return 'Windows reserved device name'
  if (ILLEGAL.test(name)) return 'illegal character'
  // MSIX 是 OPC（ZIP）包，包内路径按 URI 处理，方括号不允许（[Content_Types].xml 还是包根保留名）
  if (/[[\]]/u.test(name)) return 'square bracket (not allowed in MSIX part names)'
  if (/[. ]$/u.test(name)) return 'ends with a dot or space'
  if (name.length > 255) return 'name longer than 255 characters'
  return null
}

/** 递归扫描目录，返回 [{ path, reason }]（path 相对 root，用 / 分隔）。 */
export function scanPayload(root) {
  const found = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const reason = invalidReason(entry.name)
      if (reason) found.push({ path: relative(root, full).replaceAll('\\', '/'), reason })
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full)
    }
  }
  walk(root)
  return found
}

/** 复制程序目录给商店包用，删掉 PRUNE，返回删掉的条目与剩下的不合规路径。 */
export function prepareStorePayload(source, target) {
  if (!existsSync(source)) throw new Error(`store-payload: program directory not found: ${source}`)
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true, verbatimSymlinks: true })
  const pruned = []
  for (const item of PRUNE) {
    const path = join(target, item.path)
    if (!existsSync(path)) continue
    rmSync(path, { recursive: true, force: true })
    pruned.push(item.path)
  }
  return { pruned, invalid: scanPayload(target) }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2)
  let invalid
  if (args[0] === '--prepare') {
    const [, source, target] = args
    if (!source || !target) throw new Error('usage: store-payload-scan.mjs --prepare <program dir> <store dir>')
    const result = prepareStorePayload(resolve(source), resolve(target))
    for (const path of result.pruned) process.stdout.write(`store-payload: pruned ${path}\n`)
    invalid = result.invalid
  } else {
    invalid = scanPayload(resolve(args[0] ?? '.'))
  }
  for (const item of invalid) process.stdout.write(`${item.reason}: ${item.path}\n`)
  process.stdout.write(`store-payload: ${invalid.length} invalid name(s)\n`)
  process.exit(invalid.length ? 1 : 0)
}
