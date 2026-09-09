/* ============================================================
 * Cowork 插件入口:会话内插件体检工具
 * ============================================================
 * 装进 TokensCowork 后注册 plugin_check 工具:对任意 npm 插件包
 * 跑清单规则(与 CLI 的清单阶段同源),模型或用户在会话里即可
 * 判断"这个插件装进来会不会有问题"。含隔离启动冒烟的完整体检
 * 仍走 CLI:npx @tokensapi/dsh-plugin-check --package <name@ver>。
 * ============================================================ */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkPublishedManifest } from './registry-check.mjs'

/** 缺省比对的运行时版本;宿主升级后可通过插件配置覆盖。 */
const DEFAULT_RUNTIME = '0.1.3-alpha.1'
const REGISTRY = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 15_000

export const name = 'tokens-plugin-check'
export const inject = ['tools']

async function fetchManifest(packageName, version) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${REGISTRY}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      { signal: controller.signal, headers: { accept: 'application/json' } },
    )
    if (!response.ok) {
      throw new Error(response.status === 404 ? `npm 上未找到 ${packageName}@${version}` : `npm 查询失败(HTTP ${response.status})`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ runtime?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const runtime = typeof config.runtime === 'string' && config.runtime !== '' ? config.runtime : DEFAULT_RUNTIME
  ctx.tools.register(defineTool({
    name: 'plugin_check',
    description: 'Check whether a published DSH/TokensCowork plugin npm package is safe to install: '
      + 'forbidden lifecycle scripts, dual-kernel core dependencies, missing dsh bundle patch, '
      + 'and runtime/peer compatibility against the current DSH runtime. '
      + 'Returns ok=false with per-rule findings when the plugin would break the host.',
    parameters: {
      package: {
        type: 'string',
        required: true,
        description: 'npm package name, e.g. "@tokensapi/dsh-progressive-tools".',
      },
      version: {
        type: 'string',
        description: 'Exact version to check. Defaults to the latest dist-tag.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const manifest = await fetchManifest(args.package, args.version ?? 'latest')
      const findings = checkPublishedManifest(manifest, runtime)
      return {
        package: manifest.name,
        version: manifest.version,
        runtime,
        ok: !findings.some(finding => finding.level === 'error'),
        findings,
        note: '以上为清单规则;含隔离启动冒烟的完整体检请运行 npx @tokensapi/dsh-plugin-check --package <name@version>',
      }
    },
  }))
}
