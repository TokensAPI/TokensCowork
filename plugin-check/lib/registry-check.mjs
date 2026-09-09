/* ============================================================
 * 已发布包体检(注册表版,零依赖纯函数)
 * ============================================================
 * 对 npm registry 的版本文档跑清单规则,与目录体检(manifest-check)
 * 同一套语义,但不需要文件系统 —— 供 Cowork 插件进程内使用。
 * 冒烟阶段无法在宿主进程执行,完整体检走 CLI 或 Plugin Check
 * workflow。
 * ============================================================ */

const FORBIDDEN_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare']
const isIdentityCore = (name) =>
  name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-') || name.startsWith('@deepseek-ai/dsh')

/* ------------------------- 迷你 SemVer ------------------------- */
// 只实现体检需要的子集:比较 + 范围判定(空格=且、||=或、^、~、
// >=、>、<=、<、=、裸版本),预发布参与比较;识别不了的范围返回
// null 由调用方按"范围不合法"处理。

function parseVersion(input) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(String(input).trim())
  if (!match) return null
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/u.test(left)
    const rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

function comparatorHolds(version, operator, boundary) {
  const cmp = compareVersions(version, boundary)
  if (operator === '>') return cmp > 0
  if (operator === '>=') return cmp >= 0
  if (operator === '<') return cmp < 0
  if (operator === '<=') return cmp <= 0
  return cmp === 0
}

export function versionSatisfies(versionInput, rangeInput) {
  const version = parseVersion(versionInput)
  if (version === null) return null
  const alternatives = String(rangeInput).split('||')
  let recognized = false
  for (const alternative of alternatives) {
    const comparators = alternative.trim().split(/\s+/u).filter(Boolean)
    if (comparators.length === 0) continue
    let holds = true
    let valid = true
    for (const comparator of comparators) {
      if (comparator === '*' || comparator === 'x') continue
      const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(comparator)
      const boundary = parseVersion(match[2])
      if (boundary === null) { valid = false; break }
      const operator = match[1] ?? '='
      if (operator === '^') {
        const upper = boundary.parts[0] > 0
          ? { parts: [boundary.parts[0] + 1, 0, 0], prerelease: ['0'] }
          : boundary.parts[1] > 0
            ? { parts: [0, boundary.parts[1] + 1, 0], prerelease: ['0'] }
            : { parts: [0, 0, boundary.parts[2] + 1], prerelease: ['0'] }
        holds = holds && comparatorHolds(version, '>=', boundary) && comparatorHolds(version, '<', upper)
      } else if (operator === '~') {
        const upper = { parts: [boundary.parts[0], boundary.parts[1] + 1, 0], prerelease: ['0'] }
        holds = holds && comparatorHolds(version, '>=', boundary) && comparatorHolds(version, '<', upper)
      } else {
        holds = holds && comparatorHolds(version, operator, boundary)
      }
      if (!holds) break
    }
    if (!valid) continue
    recognized = true
    if (holds) return true
  }
  return recognized ? false : null
}

/* --------------------------- 规则 --------------------------- */

/**
 * 对一份 npm 版本清单跑体检规则。
 * @param {object} manifest - registry 版本文档(scripts/dependencies/
 *   peerDependencies/dsh/engines/license/version)。
 * @param {string} runtime - 目标 DSH 运行时版本。
 * @returns {Array<{level: 'error'|'warning', rule: string, message: string}>}
 */
export function checkPublishedManifest(manifest, runtime) {
  const findings = []
  const error = (rule, message) => findings.push({ level: 'error', rule, message })
  const warning = (rule, message) => findings.push({ level: 'warning', rule, message })

  const scripts = manifest.scripts ?? {}
  for (const script of FORBIDDEN_LIFECYCLE) {
    if (typeof scripts[script] === 'string') {
      error('M2-lifecycle', `禁止 ${script} 生命周期脚本(安装即执行任意代码);构建请改用 prepack`)
    }
  }

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (isIdentityCore(name)) {
      error('M3-core-peer', `${name} 出现在 dependencies;核心运行时必须是 peerDependencies,否则双内核实例会让 Cowork 启动失败`)
    }
  }

  const bundle = manifest.dsh?.bundle ?? {}
  if (typeof bundle.patch !== 'string' || bundle.patch === '') {
    error('M4-bundle', 'dsh.bundle.patch 缺失;宿主靠它把插件挂进加载树')
  }

  const engine = typeof manifest.dsh?.engine === 'string' ? manifest.dsh.engine : undefined
  if (engine === undefined) {
    warning('M6-engine', 'dsh.engine 未声明(目标运行时 SemVer 范围);该字段将成为上架必填')
  } else {
    const satisfied = versionSatisfies(runtime, engine)
    if (satisfied === null) error('M6-engine', `dsh.engine 不是可识别的 SemVer 范围: ${engine}`)
    else if (!satisfied) error('M6-engine', `dsh.engine "${engine}" 不覆盖当前运行时 ${runtime}`)
  }

  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    const satisfied = versionSatisfies(runtime, String(range))
    if (satisfied === null) error('M7-peer-range', `peer ${name} 的范围不可识别: ${range}`)
    else if (!satisfied) warning('M7-peer-range', `peer ${name}@"${range}" 不含当前运行时 ${runtime};宿主升级后可能运行时断裂`)
  }

  if (manifest.engines?.node === undefined) warning('M8-node-engines', 'engines.node 未声明;宿主运行在 Node 22+')
  if (manifest.license === undefined) warning('M9-license', 'license 未声明')

  const parsed = parseVersion(typeof manifest.version === 'string' ? manifest.version : '')
  if (parsed !== null && parsed.prerelease.length > 0) {
    warning('M1-manifest', `version ${manifest.version} 是预发布版;市场上架要求精确稳定版`)
  }

  return findings
}
