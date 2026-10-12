# 更新覆盖（updates）

负责关闭指向官方 DSH Desktop 的应用更新，把更新入口交给内置的 TokensCowork 更新插件，并配置产品 Release 来源。

## 文件职责

| 文件 | 负责什么 |
| --- | --- |
| [overlays.mjs](overlays.mjs) | 登记表：4 条覆盖分别在 prepare、plugins、configure 阶段执行 |
| [updates-overlay.mjs](updates-overlay.mjs) | 停用上游 desktop-updates；按是否内置更新插件改写启动菜单验收；为插件托盘项补齐命令 ID；写入产品 Release 配置 |
| [updates-overlay.test.mjs](updates-overlay.test.mjs) | 菜单谓词、命令 ID 适配、Release 配置与锚点变化回归 |
| [review.json](review.json) | pin 基线与验证证据 |

## 执行顺序

1. `staging-prepare.mjs` 停用官方更新，并切换 Profile 启动验收（有插件验收产品菜单，无插件验收全部隐藏）。
2. `staging-product-configure.mjs` 写入产品名、GitHub 仓库与 Release 地址。
3. `staging-plugins-compile.mjs` 编译后给插件托盘项补 `check-for-updates` ID，使 Desktop 顶部菜单与托盘调用同一命令。

## 验证命令

| 命令 | 检查什么 |
| --- | --- |
| `yarn test:build updates` | 覆盖代码回归 |
| `yarn product:overlays updates --check` | 记录完整性与关联 pin |

真实下载、回退和安装仍需在已安装版本上验收。跨模块顺序见[模块总览](../README.md)。
