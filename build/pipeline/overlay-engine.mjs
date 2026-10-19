/* ====================================================================
 * 覆盖执行器
 * 每个模块在 modules/<模块>/overlays.mjs 登记自己的覆盖；装配入口只调用
 * runOverlays(阶段)。执行器负责读文件、按顺序调用转换函数、统一报错、
 * 全部成功后写盘，转换函数本身不读写磁盘。
 * ==================================================================== */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AnchorError } from './anchors.mjs'

export * from './anchors.mjs'

/**
 * 装配阶段，按实际执行顺序排列。
 * - prepare：复制上游源码之后、注入产品插件之前，只改上游副本
 * - assemble：产品插件已复制进 staging，改插件副本
 * - installed：yarn install 之后，改已安装的 npm 运行时（需可重复执行）
 * - plugins：产品插件编译之后，改编译产物
 * - configure：打包前的产品配置（品牌、安装器、签名、更新来源）
 */
export const phases = ['prepare', 'assemble', 'installed', 'plugins', 'configure']

/**
 * 同一阶段内按此顺序执行。cordis.patch.yml 的追加条目依次为
 * updates → branding → guard；不同模块修改同一文件时，后者读取前者的结果。
 */
export const modules = ['platform', 'market', 'runtime', 'updates', 'branding', 'guard']

export const kinds = ['customization', 'compatibility', 'workaround']

/** 覆盖关联的固定输入；pin 变化时提示复查对应覆盖。 */
export const upstreamInputs = ['desktop', 'dsh', 'market-server', 'product']

const root = resolve(import.meta.dirname, '..', '..')

/* ----------------------------- 登记表 ----------------------------- */

/** 读取全部模块登记表，按模块顺序展开并补上 module 字段。 */
export async function loadOverlays(base = root) {
  const overlays = []
  for (const module of modules) {
    const registry = await import(pathToFileURL(resolve(base, 'build/modules', module, 'overlays.mjs')).href)
    for (const overlay of registry.default) overlays.push({ ...overlay, module })
  }
  validateOverlays(overlays)
  return overlays
}

/** 登记表结构校验；错误直接指出覆盖 id。 */
export function validateOverlays(overlays) {
  const ids = new Set()
  for (const overlay of overlays) {
    const fail = message => { throw new Error(`overlay ${overlay.id ?? '(无 id)'}: ${message}`) }
    if (typeof overlay.id !== 'string' || !overlay.id.startsWith(`${overlay.module}.`)) fail(`id 必须以 "${overlay.module}." 开头`)
    if (ids.has(overlay.id)) fail('id 重复')
    ids.add(overlay.id)
    if (!phases.includes(overlay.phase)) fail(`未知阶段 ${overlay.phase}`)
    if (!kinds.includes(overlay.kind)) fail(`未知类型 ${overlay.kind}`)
    for (const key of ['why', 'retireWhen']) if (typeof overlay[key] !== 'string' || !overlay[key].trim()) fail(`缺少 ${key}`)
    if (!Array.isArray(overlay.upstream) || overlay.upstream.length === 0) fail('缺少 upstream')
    for (const input of overlay.upstream) {
      if (!upstreamInputs.includes(input) && !/^plugin:[a-z0-9-]+$/u.test(input)) fail(`未知 upstream ${input}`)
    }
    const actions = ['apply', 'copy', 'run'].filter(key => overlay[key] !== undefined)
    if (actions.length !== 1) fail('apply / copy / run 必须且只能有一个')
    if (overlay.apply !== undefined && overlay.files === undefined) fail('apply 需要 files')
    if (overlay.when !== undefined && typeof overlay.when !== 'function') fail('when 必须是函数')
  }
}

/* ----------------------------- 执行 ----------------------------- */

const normalizeSpec = spec => typeof spec === 'string' ? { path: spec } : spec

function assertStagePath(stage, path) {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new Error(`staging 相对路径不合法：${path}`)
  const full = resolve(stage, path)
  if (!full.startsWith(`${stage}${sep}`)) throw new Error(`路径越出 staging：${path}`)
  return full
}

/**
 * 待写入的 staging 文件集合。读取优先返回本轮已修改的内容，后一个覆盖
 * 看到前一个覆盖的结果；commit 之前不会写盘。
 */
export function createStageFiles(stage, { fallback } = {}) {
  const pending = new Map()
  const origin = new Map()
  const locate = path => {
    const full = assertStagePath(stage, path)
    if (existsSync(full) || fallback === undefined) return full
    const alternative = resolve(fallback, path)
    if (existsSync(alternative)) origin.set(path, 'fallback')
    return existsSync(alternative) ? alternative : full
  }
  const files = {
    origin,
    has: path => pending.has(path) || existsSync(locate(path)),
    read(path, spec = {}) {
      if (pending.has(path)) return structuredClone(pending.get(path).value)
      const full = locate(path)
      if (!existsSync(full)) {
        if (spec.optional) return undefined
        throw new AnchorError(`目标文件不存在：${path}`)
      }
      let text = readFileSync(full, 'utf8')
      if (spec.read) text = spec.read(text)
      return spec.json ? JSON.parse(text) : text
    },
    write(path, value, spec = {}) {
      pending.set(path, { value, json: spec.json === true })
    },
    commit() {
      for (const [path, { value, json }] of pending) {
        const full = assertStagePath(stage, path)
        const content = json ? `${JSON.stringify(value, undefined, 2)}\n` : value
        if (existsSync(full) && readFileSync(full, 'utf8') === content) continue
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, content)
      }
      pending.clear()
    },
  }
  return files
}

/** 记录一条覆盖的结果；审计模式下用于体检报告。 */
function outcome(overlay, status, detail = {}) {
  return { id: overlay.id, module: overlay.module, phase: overlay.phase, status, ...detail }
}

/**
 * 执行一个阶段的全部覆盖。
 * @param phase - phases 之一。
 * @param options.stage - staging 根目录。
 * @param options.product - product.json 完整内容。
 * @param options.overlays - loadOverlays() 的结果；省略时自动加载。
 * @param options.options - 入口参数（如打包目标），覆盖从 context.options 读取。
 * @param options.audit - true 时单条失败不中断，记录后继续；用于体检的临时 staging。
 * @param options.fallback - 审计时 staging 缺少的文件改从这里读取（如已安装依赖）。
 * @returns 每条覆盖的结果：changed / unchanged / failed / skipped / unchecked。
 */
export async function runOverlays(phase, { stage, product, overlays, options = {}, audit = false, fallback } = {}) {
  if (!phases.includes(phase)) throw new Error(`未知阶段 ${phase}`)
  overlays ??= await loadOverlays()
  const files = createStageFiles(stage, { fallback: audit ? fallback : undefined })
  const context = { root, stage, product, options, files }
  const results = []
  for (const overlay of overlays.filter(item => item.phase === phase)) {
    if (overlay.when !== undefined && !overlay.when(context)) {
      results.push(outcome(overlay, 'skipped'))
      continue
    }
    try {
      if (overlay.copy !== undefined) {
        const copies = typeof overlay.copy === 'function' ? overlay.copy(context) : overlay.copy
        for (const [source, target] of copies) {
          if (!existsSync(source)) throw new AnchorError(`资源不存在：${source}`)
          const full = assertStagePath(stage, target)
          mkdirSync(dirname(full), { recursive: true })
          cpSync(source, full)
        }
        results.push(outcome(overlay, 'changed', { files: copies.map(([, target]) => target) }))
        continue
      }
      if (overlay.run !== undefined) {
        if (audit) { results.push(outcome(overlay, 'unchecked')); continue }
        files.commit()
        await overlay.run(context)
        results.push(outcome(overlay, 'changed'))
        continue
      }
      const specs = Object.fromEntries(Object.entries(
        typeof overlay.files === 'function' ? overlay.files(context) : overlay.files,
      ).map(([key, spec]) => [key, normalizeSpec(spec)]))
      const input = Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, files.read(spec.path, spec)]))
      const output = await overlay.apply(structuredClone(input), context)
      if (output === null || typeof output !== 'object') throw new Error('apply 必须返回 { 文件键: 内容 }')
      for (const key of Object.keys(output)) if (!Object.hasOwn(specs, key)) throw new Error(`apply 返回了未登记的文件键 ${key}`)
      let changed = false
      for (const [key, spec] of Object.entries(specs)) {
        if (output[key] === undefined) continue
        if (!spec.json && typeof output[key] !== 'string') throw new Error(`文件 ${spec.path} 的结果必须是字符串`)
        if (JSON.stringify(output[key]) !== JSON.stringify(input[key])) changed = true
        files.write(spec.path, output[key], spec)
      }
      results.push(outcome(overlay, changed ? 'changed' : 'unchanged', {
        files: Object.values(specs).map(spec => spec.path),
        fromFallback: Object.values(specs).some(spec => files.origin.get(spec.path) === 'fallback'),
      }))
    } catch (error) {
      const targets = overlay.files === undefined || typeof overlay.files === 'function'
        ? '' : ` ${Object.values(overlay.files).map(spec => normalizeSpec(spec).path).join(', ')}`
      const message = `[${overlay.id}]${targets}: ${error.message}`
      if (!audit) throw new Error(message, { cause: error })
      results.push(outcome(overlay, 'failed', { error: message }))
    }
  }
  files.commit()
  return results
}

/** 删除 staging 中的派生文件；供覆盖的 run 使用。 */
export function removeStageFiles(stage, paths) {
  for (const path of paths) rmSync(assertStagePath(stage, path), { recursive: true, force: true })
}
