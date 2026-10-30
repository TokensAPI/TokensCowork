/* ====================================================================
 * sessionlog 覆盖登记表
 * 内置会话日志上传插件后停用上游设置页的 Session Log 开关，同一位置只留产品自己的开关。
 * ==================================================================== */
import { desktopFiles as d, pluginEnabled } from '../../pipeline/stage-targets.mjs'
import { disableUpstreamSessionLogSetting } from './session-log-overlay.mjs'

export default [
  {
    id: 'sessionlog.disable-upstream-setting',
    phase: 'prepare',
    upstream: ['desktop', 'plugin:tokens-session-log'],
    kind: 'customization',
    when: ({ product }) => pluginEnabled(product, 'tokens-session-log'),
    files: { patch: d.desktopPatchSource },
    apply: ({ patch }) => ({ patch: disableUpstreamSessionLogSetting(patch) }),
    why: '上游 Session Log 开关只控制夹带在 DeepSeek 官方模型请求里的上传，产品走 TokensAPI 时不起作用；tokens-session-log 在同一位置（settings.general.item，order 90）注册自己的开关，两行同时出现会让用户以为有两种上传。插件未启用时上游开关保持原样。',
    retireWhen: '产品不再内置 tokens-session-log，或上游 Session Log 改为可配置上传地址、不依赖模型适配器时。',
  },
]
