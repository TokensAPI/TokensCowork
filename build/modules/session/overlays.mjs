/* ====================================================================
 * session 覆盖登记表
 * 会话菜单的「删除」：永久删除会话（T0069）。字段说明见 build/modules/README.md。
 * ==================================================================== */
import { resolve } from 'node:path'
import { desktopFiles as d, installedOverlay } from '../../pipeline/stage-targets.mjs'
import {
  exportPrivateRouteHelpers,
  openSessionMenuOnContextMenu,
  retainAgentHandles,
  wireSessionDeleteClient,
  wireSessionDeleteHost,
} from './session-delete-overlay.mjs'

const asset = file => resolve(import.meta.dirname, 'assets', file)
const lf = path => ({ path, read: text => text.replaceAll('\r\n', '\n') })

export default [
  {
    id: 'session.delete-sources',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    copy: [
      [asset('session-delete-core.ts'), 'dsh-plugin-desktop/src/tokens-session-delete-core.ts'],
      [asset('session-delete-host.ts'), 'dsh-plugin-desktop/src/tokens-session-delete.ts'],
      [asset('session-delete-client.tsx'), 'dsh-plugin-desktop/src/client/tokens-session-delete.tsx'],
    ],
    why: '删除步骤（先归档并停止 → 等停下 → 释放 Agent 与 lease → 确认没有写者 → 删目录 → 最后清注册表）、私有删除路由，以及菜单项与确认框（中英文案），供下面两条接入覆盖引用。上游没有任何删除会话的能力，归档只改注册表、不动文件。',
    retireWhen: '上游提供删除会话的 RPC 与界面，且会删掉磁盘上的会话目录时，随 session 模块整体移除。',
  },
  {
    id: 'session.delete-host',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { index: lf(d.index), route: lf(d.settingsRoute) },
    apply: ({ index, route }) => ({ index: wireSessionDeleteHost(index), route: exportPrivateRouteHelpers(route) }),
    why: '删除路由只接受本机 Desktop 窗口的请求：先过宿主连接自己的拒绝判定，再走与「删除 Profile」相同的回环 + 精确 Origin 校验，局域网 HTTPS、远程控制和普通浏览器都被拒绝。不走 typert：新开命名空间要跑上游生成器并改生成产物。',
    retireWhen: '随 session.delete-sources 一起移除。',
  },
  {
    id: 'session.delete-client',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { clientIndex: lf(d.clientIndex) },
    apply: ({ clientIndex }) => ({ clientIndex: wireSessionDeleteClient(clientIndex) }),
    why: '会话菜单插槽 sidebar.workspaces.session.menu.item 是公开扩展点；在 Desktop 客户端入口注册「删除」（order 500，危险色，排在复制 Session ID 之后），确认框挂 shell.overlay。只有 Desktop 窗口执行这个 apply，与只认本机窗口的删除路由一致。',
    retireWhen: '随 session.delete-sources 一起移除。',
  },
  {
    id: 'session.agent-handles',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'workaround',
    ...installedOverlay('@deepseek-ai/dsh-agent', retainAgentHandles,
      'dsh-agent is not installed; Agent handle retention cannot be applied'),
    why: 'session-controller 调 agents.resume/create 后只留 .agent、把 AgentHandle 丢了，会话一旦打开，Agent、写句柄和 lease 就一直留到进程退出，外部没有公开途径释放；不释放就删目录，进程里会剩一个还在写的会话。注册表记下 handle，并加 tokensReleaseAgent(id) 用 handle.dispose() 按上游自己的顺序拆掉（取消、等空闲、关写句柄、退出注册表）。',
    retireWhen: '上游提供按会话卸载 Agent 的公开接口（或自带删除会话）时，改用该接口后删除。',
  },
  {
    id: 'session.row-context-menu',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'customization',
    ...installedOverlay('@deepseek-ai/dsh-client-ui-workspace', openSessionMenuOnContextMenu,
      'dsh-client-ui-workspace is not installed; the Session row context menu cannot be applied', 'lib/client.js'),
    why: '固定的 DSH 0.2.1-rc.2 会话行只有行尾「…」菜单，没有右键菜单（上游 10-26 才加）；用户要求右键删除（仿 Codex）。右键在光标处打开同一个「…」菜单，菜单项仍全由插槽提供，空白新会话行保持浏览器默认。',
    retireWhen: '上游会话行自带右键菜单、且同样渲染 sidebar.workspaces.session.menu.item 插槽时删除。',
  },
]

/** 本模块的检查脚本：不修改 staging，只验收结果。 */
export const checks = [
  { file: 'staging-session-delete-smoke.mjs', runBy: '手动：node build/modules/session/staging-session-delete-smoke.mjs <staging 宿主根>（真实宿主、临时 DSH_HOME）' },
]
