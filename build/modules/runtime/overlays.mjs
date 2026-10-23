/* ====================================================================
 * runtime 覆盖登记表
 * DSH 版本、首次启动、stderr、测试适配、外部浏览器登录桥、RPC 作用域、
 * 摘要压缩、联网搜索设置。字段说明见 build/modules/README.md。
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
import { keepDshRuntimeSeries } from './profile-package-overlay.mjs'
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
]
