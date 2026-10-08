# IM 会话列表图标与标题重叠诊断

日期：2026-10-08。范围：定位与对照验证；未修改产品或插件实现。

## 结论

已在独立 Chromium 测试页复现反馈截图中的微信图标/标题重叠，以及同机制的 WhatsApp 标题重叠。触发条件是 Connect 会话标题图标替换逻辑与 UI 插件 Lake View（clean）浅色主题的文字阴影同时生效。

这属于两个插件之间的样式兼容问题。原始标题没有被真正隐藏：Connect 设置透明文字填充，但 UI 主题继承的非透明文字阴影仍然绘制；它与 Logo 和替换标题叠在同一位置。复现并不需要长标题、窄窗口或玻璃面板。

## 依据与位置

- Connect 独立仓库：`C:/Users/wzm/maohui/github_repo/tokens_DshConnect_code`，包 `@tokensapi/dsh-connect@2.9.0`，HEAD `4e0e87733b69c7cb210d9a21887495f0b931b612`。
- `plugin-src/client/session-channel-logos.js:80` 起：原始标题设置 `-webkit-text-fill-color: transparent`；`::before` 绘制 16px Logo，`::after` 从 22px 偏移处绘制去掉渠道前缀的标题。原始 React 文字保留在 DOM 中。
- 产品 UI 固定提交：`7f03733d36c7ee1bb37210e7362782a67af077b5`，版本 `0.2.22`。测试直接通过 `git show` 读取该提交的样式。
- `plugins/dsh-tokensapi-ui/src/client/theme/dsh-bridge.css:17` 在根与 body 上设置 `text-shadow: var(--theme-text-shadow)`，该属性向标题继承。
- `plugins/dsh-tokensapi-ui/src/client/theme/themes/clean.css:78` 为浅色主题设置 `0 0 .42px currentColor` 等阴影。即使文字填充透明，currentColor 阴影依然可见。
- 宿主真实行布局来自 `desktop/deepseek-harness/packages/client/ui-workspace/src/client/rows/Rows.module.css`。

## 对照验证

使用真实 Connect 模块经 esbuild 打包后安装到合成会话列表。合成标题为“微信 · 你好”和“WhatsApp · 我要生成广告图”，没有读取真实会话内容。

| 条件 | 结果 |
| --- | --- |
| Connect + 固定 UI 浅色样式 | 微信 Logo 后方透出原始前缀，WhatsApp 原始标题与替换标题重叠，视觉表现符合反馈截图 |
| 仅为装饰后的原始标题增加 `text-shadow: none` | 两个渠道重叠均消失；原始 DOM 文本保留，Logo 和替换标题正常 |
| 原始标题无阴影，单独给 `::after` 恢复主题阴影 | 仍无重叠，证明可保留可见标题的主题文字效果 |
| 卸载 Connect 图标适配器 | 恢复含渠道前缀的单层普通文字，无重叠 |

原标题计算样式为透明填充，但阴影为 `rgb(17, 17, 17) 0px 0px 0.42px, rgba(20, 71, 48, 0.11) 0px 1px 1px`。清除阴影前后标题宽度均为 `247.921875px`，右侧时间位置未改变。

本机 TokensCowork 当前未暴露运行窗口，按 app ID 打开也超时。因此以上是代码级独立浏览器复现，不是反馈者原始会话或运行中桌面页面的 DOM 验证。反馈者的实际插件版本、主题和缩放尚未采集。

## 修复归属建议

优先在 Connect 的 `session-channel-logos.js` 中完善原始标题隐藏规则：只对同时具有 `data-dsh-im-session-channel` 和 `data-dsh-im-session-text` 的标题清除 `text-shadow`。若保留主题阴影，应仅施加到可见的 `::after`，避免再次让隐藏的原始文字绘制出来。

UI 插件也可增加针对上述两个属性的兼容规则作为替代。无需全局取消阴影，也无需改变会话行宽度或时间列。正式修改应在对应插件的独立仓库执行；本 superproject 的子模块保持只读。

正式验收还应覆盖浅色/深色、玻璃开关、微信/WhatsApp、普通会话、搜索结果、长标题省略、重命名及插件卸载后的恢复，并在真实桌面环境观察。

## 本地证据

以下文件位于忽略目录 `.build/diagnostics/`，不是发布产物：

- `im-logo-repro.cjs`：可运行复现脚本；执行 `node .build/diagnostics/im-logo-repro.cjs`。
- `im-logo-repro.html`：合成列表与真实宿主/UI 样式，Connect 适配器由脚本注入。
- `im-logo-evidence.json`：对照计算样式。
- `im-logo-shadow-before.png`：重叠复现。
- `im-logo-shadow-none.png`：清除原始标题阴影后的结果。
- `im-logo-shadow-isolated.png`：可见标题保留主题阴影。
- `im-logo-plugin-disabled.png`：卸载图标替换后的结果。

未修改子模块、独立 Connect 仓库、本机 Profile 或凭据；未安装、升级、提交、推送或发布插件。
