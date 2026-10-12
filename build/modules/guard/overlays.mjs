/* ====================================================================
 * guard 覆盖登记表
 * 内置循环护栏插件后停用上游重复工具提醒，避免同一次重复收到两条提醒。
 * ==================================================================== */
import { desktopFiles as d, pluginEnabled } from '../../pipeline/stage-targets.mjs'
import { disableUpstreamRepeatReminder } from './loop-guard-overlay.mjs'

export default [
  {
    id: 'guard.disable-repeat-reminder',
    phase: 'prepare',
    upstream: ['desktop', 'plugin:tokens-loop-guard'],
    kind: 'customization',
    when: ({ product }) => pluginEnabled(product, 'tokens-loop-guard'),
    files: { patch: d.desktopPatchSource },
    apply: ({ patch }) => ({ patch: disableUpstreamRepeatReminder(patch) }),
    why: '上游 repeat-tool-reminder 只做精确匹配且只提醒；tokens-loop-guard 同时覆盖精确与近似重复并在高阈值硬阻断。两者同开会重复提醒，插件未启用时上游保持兜底。',
    retireWhen: '上游 repeat-tool-reminder 原生支持近似匹配与可配置硬阻断时，移除覆盖并回退到上游护栏。',
  },
]
