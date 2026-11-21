/* ====================================================================
 * runtime 覆盖登记表
 * DSH 版本、打包 pnpm 版本、首次启动、stderr、测试适配、外部浏览器登录桥、RPC 作用域、
 * 摘要压缩、输出上限、联网搜索设置。字段说明见 build/modules/README.md。
 * ==================================================================== */
import { desktopFiles as d, desktopInstalled, installedOverlay, pluginEnabled, productPlugin } from '../../pipeline/stage-targets.mjs'
import { alignCompactionSummary } from './compaction-overlay.mjs'
import { keepRestartRequestable } from './desktop-actions-overlay.mjs'
import {
  alignCliRuntimeSmokeWithPlatform,
  alignResolverTestFileUrls,
  protectDesktopStderr,
  skipDesktopSetupWizard,
} from './desktop-runtime-overlay.mjs'
import { alignDiagnosticsSpec, keepErrorCodesReadable } from './mask-secrets-overlay.mjs'
import { addDesktopOpenExternal } from './open-external-overlay.mjs'
import { keepConfiguredOutputLimit } from './output-limit-overlay.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { keepDshRuntimeSeries } from './profile-package-overlay.mjs'
import {
  alignPnpmDependency,
  alignPnpmNotice,
  alignPnpmPackageSpec,
  alignPnpmResolutions,
  normalizePatch,
  PNPM_PATCH,
} from './pnpm-version-overlay.mjs'
import {
  alignConnectionRpcScope,
  alignLegacySearchSettingsImport,
  alignRuntimeDependencies,
  alignRuntimeVersion,
} from './runtime-version-overlay.mjs'

const runtimeVersion = product => product.desktop.runtimeVersion

export default [
  {
    id: 'runtime.dsh-version',
    phase: 'prepare',
    upstream: ['desktop', 'dsh'],
    kind: 'compatibility',
    files: ({ files }) => ({
      workspace: d.workspacePackage,
      yarnConfig: d.yarnConfig,
      ...Object.fromEntries(files.read('package.json', { json: true }).workspaces.map(entry => {
        if (entry.includes('*')) throw new Error(`Unexpected upstream workspace glob: ${entry}`)
        return [`manifest:${entry}`, { path: `${entry}/package.json`, json: true }]
      })),
    }),
    apply: (input, { product }) => {
      const manifests = Object.fromEntries(Object.entries(input).filter(([key]) => key.startsWith('manifest:')))
      const result = alignRuntimeVersion({ workspace: input.workspace, yarnConfig: input.yarnConfig, manifests }, runtimeVersion(product))
      return { workspace: result.workspace, yarnConfig: result.yarnConfig, ...result.manifests }
    },
    why: '统一外层固定的 DSH 依赖及 peers，保留 Desktop Yarn patches，冷却期只豁免产品固定版本。',
    retireWhen: 'Desktop 原生依赖图与产品固定运行时一致时评估缩减；不能删除闭包及 immutable lock 验证。',
  },
  {
    id: 'runtime.pnpm-version',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'workaround',
    files: ({ files }) => ({
      workspace: d.workspacePackage,
      patch: { path: PNPM_PATCH, optional: true },
      ...Object.fromEntries(files.read('package.json', { json: true }).workspaces
        .map(entry => [`manifest:${entry}`, { path: `${entry}/package.json`, json: true }])),
      ...Object.fromEntries(['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']
        .map(variant => [`notice:${variant}`, `${variant}/THIRD_PARTY_NOTICES.md`])),
    }),
    apply: input => Object.fromEntries(Object.entries(input).map(([key, value]) => {
      if (key === 'workspace') return [key, { ...value, resolutions: alignPnpmResolutions(value.resolutions) }]
      // 上游 anywhere-labs/deepseek-harness-desktop 06446375 的 patches/pnpm@11.28.5.patch，原样（LF）。
      if (key === 'patch') return [key, normalizePatch(readFileSync(resolve(import.meta.dirname, 'assets', 'pnpm@11.28.5.patch'), 'utf8'))]
      if (key.startsWith('notice:')) return [key, alignPnpmNotice(value)]
      return [key, alignPnpmDependency(value, key.slice('manifest:'.length))]
    })),
    why: 'pnpm 11.8.0 的 finishWorkers() 清空线程池引用，Done 之后晚到的抓取（其他平台可选依赖，如 sharp 的 @img/*）新建一个没人关闭的池，进程不退出（pnpm#12297/#13617，#13226 修复于 11.23.0）；宿主插件管理器等 pnpm 退出，市场更新插件卡到 10 分钟静默上限并误报“没能卸载”。与上游 Desktop 271cc526 一样打包 11.28.5，resolutions 与补丁换成上游 06446375 的 patches/pnpm@11.28.5.patch（同一处 minimumReleaseAge 修正）。',
    retireWhen: '固定的 Desktop pin 自带 pnpm ≥ 11.23.0（上游 271cc526 之后的版本）时删除，连同 runtime.test-pnpm-version 与 assets/pnpm@11.28.5.patch；删除前用 pnpm-exit-regression.mjs 复验。',
  },
  {
    id: 'runtime.test-pnpm-version',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'workaround',
    files: {
      stable: 'dsh-plugin-desktop/tests/package.spec.ts',
      beta: 'dsh-plugin-desktop-beta/tests/package.spec.ts',
    },
    apply: ({ stable, beta }) => ({ stable: alignPnpmPackageSpec(stable), beta: alignPnpmPackageSpec(beta) }),
    why: 'Stable/Beta 的 package.spec 断言打包 pnpm 的版本、锁文件条目与补丁条目；只把这三处的 11.8.0 换成 11.28.5（与上游 271cc526 的改法一致），补丁内容断言不变，staging 的 Desktop vitest 保持可跑。',
    retireWhen: '随 runtime.pnpm-version 一起删除。',
  },
  {
    id: 'runtime.skip-setup-wizard',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { main: d.main },
    apply: ({ main }) => ({ main: skipDesktopSetupWizard(main) }),
    why: '使用产品已装配的默认 Profile，跳过页面级首次向导并写入 skip 标记；Safe Mode 不写入。',
    retireWhen: '产品恢复向导，或上游提供显式配置时移除。',
  },
  {
    id: 'runtime.log-error-codes',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { mask: d.maskSecrets },
    apply: ({ mask }) => ({ mask: keepErrorCodesReadable(mask) }),
    why: '上游把字段名 code 当凭据一律脱敏，宿主/插件日志里的错误码全成 ****；用户决定 code 一律不按字段名脱敏（按值猜形状的规则会漂），auth_code/authorization_code、URL 查询串与长 token 通用规则照旧。',
    retireWhen: '上游不再把 code 列为密钥字段名时移除。',
  },
  {
    id: 'runtime.test-log-error-codes',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { spec: d.diagnosticsSpec },
    apply: ({ spec }) => ({ spec: alignDiagnosticsSpec(spec) }),
    why: '上游 diagnostics.spec 把 code 当必须脱敏的样例；改成产品口径（code 保留、auth_code 仍脱敏），staging 的 Desktop vitest 保持可跑。',
    retireWhen: '随 runtime.log-error-codes 一起移除。',
  },
  {
    id: 'runtime.restart-requestable',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'workaround',
    files: { actions: d.desktopActions },
    apply: ({ actions }) => ({ actions: keepRestartRequestable(actions) }),
    why: '上游 desktopActions.requestRestart() 在确认框被取消后也把重启记成"已完成"，之后的调用直接返回；市场的"立即重启"按钮取消一次后就再也弹不出确认框，只能手动退出重开（T0048 真机验收命中）。去掉"已完成"闩，只保留进行中去重。',
    retireWhen: '上游 requestRestart 不再在取消后闩住（restartCompleted 只在真正重启时置位）时移除。',
  },
  {
    id: 'runtime.gui-stderr',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'workaround',
    files: { main: d.main, logger: d.logger },
    apply: ({ main, logger }) => protectDesktopStderr(main, logger),
    why: '避免 Windows GUI 启动时已断开的 stderr 管道再次抛 EPIPE，掩盖启动根因。',
    retireWhen: '上游包含等效防护，且断管写入回归通过后删除。',
  },
  {
    id: 'runtime.cli-smoke-platform',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { verifier: d.cliRuntimeVerifier },
    apply: ({ verifier }) => ({ verifier: alignCliRuntimeSmokeWithPlatform(verifier) }),
    why: '上游 CLI smoke 按字符串直比 Node 路径；Windows 批处理 shim 需保留 Electron Node 模式并规范化路径。',
    retireWhen: '上游 smoke 支持 Windows shim 路径与 Node 模式后移除。',
  },
  {
    id: 'runtime.resolver-test-urls',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { tests: d.moduleResolutionTests },
    apply: ({ tests }) => ({ tests: alignResolverTestFileUrls(tests) }),
    why: '上游解析测试夹具使用无盘符的 POSIX file URL，Windows 上补盘符；不改生产模块解析。',
    retireWhen: '上游夹具支持 Windows 路径后移除。',
  },
  {
    id: 'runtime.open-external',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { bridge: d.hostRuntimeBridge, runtime: d.runtimeTypes },
    apply: input => addDesktopOpenExternal(input),
    why: 'tokens-login 在隔离 Host 中没有 shell 能力；在 desktopRuntime 桥上只加 openExternal，仅放行 HTTPS 与回环 HTTP，由默认浏览器完成登录。',
    retireWhen: '上游提供可用的外部打开能力，或产品改用服务端设备授权流程后移除。',
  },
  {
    id: 'runtime.profile-runtime-series',
    phase: 'prepare',
    upstream: ['desktop', 'dsh'],
    kind: 'workaround',
    files: { selector: d.packageOverlay },
    apply: ({ selector }) => ({ selector: keepDshRuntimeSeries(selector) }),
    why: '与官方 DSH 共用 ~/.dsh/profiles/desktop 时，官方程序装入的下一版本系列 DSH 运行时包版本更高，会替换内置运行时并启动失败；跨系列时保留安装包，市场插件等其他包仍按新版本覆盖。',
    retireWhen: '产品改用独立的 DSH 数据目录或 Profile，或上游选包时自行拒绝不兼容的运行时系列后删除。',
  },
  {
    id: 'runtime.plugin-dependencies',
    phase: 'assemble',
    upstream: ['dsh', 'product'],
    kind: 'compatibility',
    files: ({ product }) => Object.fromEntries(product.plugins
      .filter(plugin => plugin.enabledByDefault === true)
      .map(plugin => [plugin.id, { path: productPlugin(plugin.id, 'package.json'), json: true }])),
    apply: (manifests, { product }) => Object.fromEntries(Object.entries(manifests)
      .map(([id, manifest]) => [id, alignRuntimeDependencies(manifest, runtimeVersion(product))])),
    why: '产品插件与宿主共用同一套 DSH 运行时，插件的 DSH 依赖及 peers 对齐产品固定版本。',
    retireWhen: '插件发布版本与产品运行时固定一致时，仍保留作为装配约束；不单独删除。',
  },
  {
    id: 'runtime.rpc-scope',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'workaround',
    ...installedOverlay('@deepseek-ai/dsh-client-connection', alignConnectionRpcScope,
      'client-connection is not installed; RPC scope adaptation cannot be verified'),
    why: 'Cordis getter shadow 导致 RPC 注册拿不到 webServer；显式注入 webServer，生命周期仍归调用方。',
    retireWhen: '未加工的上游 Connection 通过相同注册、鉴权、显式注销和插件卸载回归后删除。',
  },
  {
    id: 'runtime.compaction-summary',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'workaround',
    ...installedOverlay('@deepseek-ai/dsh-compaction-basic', alignCompactionSummary,
      'compaction-basic is not installed; run yarn install first'),
    why: '真实压缩曾返回 ACK / 拒绝式文本并替换历史；摘要改为独立系统任务、历史作为引用数据，并校验八段 checkpoint，无效摘要保留历史。',
    retireWhen: '上游提供等效隔离与无效输出保护，并通过 ACK、拒绝、截断、失败保留历史及真实压缩回归后删除；不能只按版本号删除。',
  },
  {
    id: 'runtime.output-limit',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'workaround',
    ...installedOverlay('@earendil-works/pi-ai', keepConfiguredOutputLimit,
      'pi-ai is not installed; run yarn install first', 'dist/api/simple-options.js'),
    why: 'pi-ai 把每次请求的 max_tokens 压到「窗口 − 估算 − 4096」；DSH 交给它的历史用量恒为空，估算退化成整段对话按 3.5 字符/token 粗估并计入历史思考（回放为 reasoning 字段，TokensAPI 不计入输入），长会话里实际用量 69% 时估算已超窗口，输出上限被压到 907 再到 1，「继续」永远截断（T0095，会话 14d7fdc4）。没有上报用量时改为发送配置的输出上限：压缩阈值 = min(窗口×0.8, 窗口 − 路由声明的 maxTokens（未声明为 0）− headroom 65536)，输入至少比窗口低 65536，容得下本产品发送的 32768；单步越界时 TokensAPI 返回 maximum context length 报错，pi-ai 识别为溢出并由 DSH 压缩恢复。未声明的输出上限若超过 headroom（DSH 0.2.2 默认 128K）须重新评估。',
    retireWhen: 'DSH 的 pi-ai 适配器向 pi-ai 传入真实用量，或 pi-ai 不再用纯字符估算压低输出上限，并以同一会话数字（估算 257141 / 258116、窗口 262144）回归得到配置上限后删除。',
  },
  {
    id: 'runtime.web-search-settings',
    phase: 'plugins',
    upstream: ['dsh', 'plugin:tokens-dsh-web-search'],
    kind: 'compatibility',
    when: ({ product }) => pluginEnabled(product, 'tokens-dsh-web-search'),
    files: {
      settings: desktopInstalled('@deepseek-ai/dsh-settings'),
    },
    apply: ({ settings }) => ({
      settings: alignLegacySearchSettingsImport(settings),
    }),
    why: '插件自 0.2.1 起自带 DSH 0.2 设置契约，但从 0.1 一次性导入设置时，宿主只认识自己的分区；旧 free-search 命名空间需映射到联网搜索的 Profile 条目，否则老用户的搜索配置会导入到错误条目。',
    retireWhen: '宿主的旧设置导入能识别插件分区，或产品不再支持从 0.5 升级时，通过旧配置导入回归后删除。',
  },
]

/** 本模块的检查脚本：不修改 staging，只验收结果。 */
export const checks = [
  { file: 'staging-compaction-smoke.mjs', runBy: 'staging-runtime-patch.mjs（installed 阶段之后自动执行）' },
  { file: 'staging-rpc-smoke.mjs', runBy: 'build/build.mjs（installed 阶段之后自动执行）' },
  { file: 'pnpm-exit-regression.mjs', runBy: '手动：用装配出的插件管理器与打包 pnpm 验证安装/卸载/更新后按时退出（--live 走真实 Registry）' },
]
