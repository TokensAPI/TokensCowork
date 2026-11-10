# 会话删除（session）

会话菜单（行尾「…」，右键同样打开）里的「删除」：确认后永久删除会话目录，不进回收站（T0069）。
上游没有任何删除会话的能力；归档只改注册表，不动文件。

## 文件职责

| 文件 | 负责什么 |
| --- | --- |
| [overlays.mjs](overlays.mjs) | 登记表：5 条覆盖的阶段、目标文件、原因与删除条件 |
| [session-delete-overlay.mjs](session-delete-overlay.mjs) | 纯转换函数：接入 Desktop 宿主与客户端入口、dsh-agent 保留 AgentHandle、会话行右键 |
| [assets/session-delete-core.ts](assets/session-delete-core.ts) | 删除步骤与宿主绑定（复制为 `src/tokens-session-delete-core.ts`） |
| [assets/session-delete-host.ts](assets/session-delete-host.ts) | 私有删除路由 `POST /tokens/session/delete`（复制为 `src/tokens-session-delete.ts`） |
| [assets/session-delete-client.tsx](assets/session-delete-client.tsx) | 菜单项、确认框、中英文案（复制为 `src/client/tokens-session-delete.tsx`） |
| [staging-session-delete-smoke.mjs](staging-session-delete-smoke.mjs) | 真实宿主冒烟：临时 DSH_HOME 里现造会话，跑产品自己的删除代码 |
| `*.test.mjs` | 外层回归：删除步骤（替身宿主）与转换函数（固定上游输入） |
| [review.json](review.json) | pin 基线与验证证据 |

## 删除顺序

1. 客户端先走上游自己的「停止并归档」（同时把正在看的会话从主视图清掉），再请求删除路由。
2. 路由：宿主连接自己的拒绝判定 → 回环 + 精确 Origin（与删除 Profile 同一套）→ 只收 `{ sessionId }`。
3. 宿主：归档并请求停止 → 等活动清空、没有 Agent 在跑（最长 15 秒，超时返回 409，会话保持归档）→
   用保留的 AgentHandle 释放 Agent（关闭写句柄、释放 lease）→ 打开再关闭一次写句柄，确认没有别的写者 →
   删 `<root>/<projectKey(cwd)>/<encodeSegment(id)>/` → 最后从工作区、置顶、归档集合里去掉这个 id。
4. 子智能体会话一起删（先子后父）；fork 出来的会话是独立会话，不删。附件按内容寻址、多会话共用，不删。

## 验证命令

| 命令 | 检查什么 |
| --- | --- |
| `yarn test:build session` | 删除步骤与转换函数；有 `.build/desktop`（或 `TOKENS_STAGE_ROOT`）时也对已安装产物做语法检查 |
| `node build/modules/session/staging-session-delete-smoke.mjs .build/desktop/dsh-plugin-desktop` | 真实宿主：冷会话、界面打开的会话、正在运行的会话、重复删除 |
| `yarn product:overlays session --check` | 登记完整性与关联 pin |

开发版里的右键菜单、确认框和截图仍需人工验收。
