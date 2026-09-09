/* ============================================================
 * 阶段①:清单体检(纯静态,秒级,离线)
 * ============================================================
 * 每一条规则都对应一种已经真实发生过的"把宿主搞崩/搞坏"路径,
 * 规则说明写在 README;error 挡上架,warning 提示即将收紧或
 * 潜在错配。判定为纯函数,便于单测与市场门禁复用。
 * ============================================================ */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { extractPatchRows } from './patch-rows.mjs'

/** 安装即执行任意代码的脚本;市场受控安装的既有红线。 */
const FORBIDDEN_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare']

/**
 * 携带身份语义的核心包:cordis 上下文与 dsh 服务在宿主/插件各持一份时
 * Symbol 不等,注册对不上。schemastery、cosmokit 等纯工具库不在此列,
 * 插件可以正常依赖。
 */
const CORE_SCOPE = '@deepseek-ai/'
const isIdentityCore = (name) => name === '@deepseek-ai/cordis'
  || name.startsWith('@deepseek-ai/cordis-')
  || name.startsWith('@deepseek-ai/dsh')

const SUSPICIOUS_FILE = /(\.env(\.|$)|id_rsa|\.pem$|\.p12$|\.key$)/u

/**
 * 对一个插件目录执行全部清单规则。
 * @param {string} pluginDir - 插件根目录(含 package.json)。
 * @param {{ runtime?: string }} [options] - runtime 为目标 DSH 运行时
 *   版本(如 0.1.3-alpha.1);给出时才执行 engine/peer 与其的交集判定。
 * @returns {{ findings: Array<{level: 'error'|'warning', rule: string, message: string}>, manifest?: object, rows?: object[] }}
 */
export function checkManifest(pluginDir, options = {}) {
  const findings = []
  const error = (rule, message) => findings.push({ level: 'error', rule, message })
  const warning = (rule, message) => findings.push({ level: 'warning', rule, message })

  const manifestPath = resolve(pluginDir, 'package.json')
  if (!existsSync(manifestPath)) {
    error('M1-manifest', 'package.json 不存在')
    return { findings }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    error('M1-manifest', `package.json 不是合法 JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
    return { findings }
  }

  if (typeof manifest.name !== 'string' || manifest.name === '') {
    error('M1-manifest', 'name 缺失')
  }
  if (typeof manifest.version !== 'string' || semver.valid(manifest.version) === null) {
    error('M1-manifest', 'version 不是合法 SemVer')
  } else if (semver.prerelease(manifest.version) !== null) {
    warning('M1-manifest', `version ${manifest.version} 是预发布版;市场上架要求精确稳定版`)
  }

  const scripts = manifest.scripts ?? {}
  for (const script of FORBIDDEN_LIFECYCLE) {
    if (typeof scripts[script] === 'string') {
      error('M2-lifecycle', `禁止 ${script} 生命周期脚本(安装即执行任意代码,市场受控安装会拒绝);构建请改用 prepack`)
    }
  }

  const dependencies = manifest.dependencies ?? {}
  for (const name of Object.keys(dependencies)) {
    if (isIdentityCore(name)) {
      error('M3-core-peer', `${name} 出现在 dependencies;核心运行时必须声明为 peerDependencies,否则宿主与插件各持一份实例,服务注册无法对上,典型症状是整个 Cowork 启动失败`)
    }
  }

  const dsh = manifest.dsh ?? {}
  const bundle = dsh.bundle ?? {}
  let rows
  if (typeof bundle.patch !== 'string' || bundle.patch === '') {
    error('M4-bundle', 'dsh.bundle.patch 缺失;宿主靠它把插件挂进加载树')
  } else {
    const patchPath = resolve(pluginDir, bundle.patch)
    if (!existsSync(patchPath)) {
      error('M4-bundle', `dsh.bundle.patch 指向的文件不存在: ${bundle.patch}`)
    } else {
      const extracted = extractPatchRows(readFileSync(patchPath, 'utf8'))
      for (const problem of extracted.problems) error('M4-bundle', `补丁行不合法: ${problem}`)
      rows = extracted.rows
      if (rows.length === 0 && extracted.problems.length === 0) {
        error('M4-bundle', '补丁未声明任何插件行')
      }
      const packageName = typeof manifest.name === 'string' ? manifest.name : ''
      for (const row of rows ?? []) {
        if (packageName !== '' && row.name !== packageName && !row.name.startsWith(`${packageName}/`)) {
          error('M5-row-scope', `补丁行 "${row.id ?? row.name}" 指向 ${row.name},超出本包命名空间(${packageName});插件只能挂载自己的入口`)
        }
      }
    }
  }

  const engine = typeof dsh.engine === 'string' ? dsh.engine : undefined
  if (engine === undefined) {
    warning('M6-engine', 'dsh.engine 未声明(目标 DSH 运行时 SemVer 范围,如 ">=0.1.3-alpha.1 <0.2");该字段将成为上架必填')
  } else if (semver.validRange(engine, { includePrerelease: true }) === null) {
    error('M6-engine', `dsh.engine 不是合法 SemVer 范围: ${engine}`)
  } else if (options.runtime !== undefined
    && !semver.satisfies(options.runtime, engine, { includePrerelease: true })) {
    error('M6-engine', `dsh.engine "${engine}" 不覆盖目标运行时 ${options.runtime}`)
  }

  const peers = manifest.peerDependencies ?? {}
  if (options.runtime !== undefined) {
    for (const [name, range] of Object.entries(peers)) {
      if (!name.startsWith(`${CORE_SCOPE}dsh`)) continue
      if (semver.validRange(range, { includePrerelease: true }) === null) {
        error('M7-peer-range', `peer ${name} 的范围不合法: ${range}`)
      } else if (!semver.satisfies(options.runtime, range, { includePrerelease: true })) {
        warning('M7-peer-range', `peer ${name}@"${range}" 不含目标运行时 ${options.runtime};宿主升级后此插件可能在运行时断裂(接口错配类故障)`)
      }
    }
  }

  if (manifest.engines?.node === undefined) {
    warning('M8-node-engines', 'engines.node 未声明;宿主运行在 Node 22+')
  }
  if (manifest.license === undefined) {
    warning('M9-license', 'license 未声明')
  }

  const filesList = Array.isArray(manifest.files) ? manifest.files : []
  for (const entry of filesList) {
    if (typeof entry === 'string' && SUSPICIOUS_FILE.test(entry)) {
      error('M10-secrets', `files 白名单包含疑似凭据文件: ${entry}`)
    }
  }
  for (const candidate of ['.env', 'id_rsa']) {
    const candidatePath = join(pluginDir, candidate)
    if (existsSync(candidatePath) && statSync(candidatePath).isFile() && filesList.length === 0) {
      warning('M10-secrets', `目录含 ${candidate} 且未用 files 白名单限定发布内容,npm pack 可能把它带上`)
    }
  }

  return { findings, manifest, rows }
}
