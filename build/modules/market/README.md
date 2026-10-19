# 市场覆盖（market）

负责桌面市场的固定来源、账户授权、私有 Registry、插件更新和发现首页。主题弹窗定位已由 UI 0.2.24 自身修复，不再在构建中改写。
来源配置读取 `market/server/source.config.json` 与生成的 `source.json`；覆盖只加工 staging，源码子模块保持只读。

## 文件职责

| 文件 | 负责什么 |
| --- | --- |
| [overlays.mjs](overlays.mjs) | 登记表：23 条市场覆盖的目标文件、执行顺序、原因与删除条件 |
| [market-source-overlay.mjs](market-source-overlay.mjs) | 固定唯一来源、修复旧来源、Fake-IP 网络适配、隐藏来源管理及统一品牌文案 |
| [market-auth-overlay.mjs](market-auth-overlay.mjs) | 当前 API Key 目录鉴权、Key 切换缓存失效、不持久化授权目录、防止凭据向第三方透传 |
| [market-update-overlay.mjs](market-update-overlay.mjs) | npm 插件检查、确认和执行更新，保留配置、启用状态及重启提示 |
| [market-registry-overlay.mjs](market-registry-overlay.mjs) | 私有包身份、schema、版本验证及共享 Registry 安装路由；服务端凭据留在服务端 |
| [market-home-overlay.mjs](market-home-overlay.mjs) | 默认发现页、灰色已安装卡片、详情自动检查更新和失败重试，复用原生布局与操作 |
| [market-desktop-overlay.mjs](market-desktop-overlay.mjs) | Desktop 正常启动固定市场提供者并修复旧偏好，保留 Safe Mode 例外 |
| [market-catalog-verify.mjs](market-catalog-verify.mjs) | 校验生成来源、产品组件清单和初始 SQLite 目录；产品输入检查自动调用 |
| `*-overlay.test.mjs` | 外层覆盖代码回归，直接对照固定上游输入 |
| [overlays.test.mjs](overlays.test.mjs) | 按登记表实际装配市场源码；重复应用与后期锚点失配均报出覆盖 id 且不写入 |
| [market-routing-integration.test.mjs](market-routing-integration.test.mjs) | 直接验证现有服务路由的 SQLite 授权、归档下载、撤权及包名歧义；不再加工服务源码 |
| `market-update.spec.ts`、`market-registry-candidates.spec.ts`、`market-home-ui-tests.inc` | 复制或拼接到 staging，由 Market 的 Vitest 执行功能和界面行为回归 |
| [review.json](review.json) | pin 基线与验证证据 |

## 执行顺序

`prepare` 阶段按登记顺序执行：

1. 产品来源和网络适配 → 当前 Key 鉴权。
2. 插件更新 → 私有 Registry → 客户端 API。
3. 发现首页和样式 → 最终品牌文案。
4. 适配上游测试、载入产品回归模板。

覆盖函数只转换内容，后一步读取前一步结果；执行器在整个阶段成功后才写盘，锚点失配时市场文件不会部分改写。不支持对已加工源码重复应用。

Desktop 提供者策略和主题弹窗修复也由 prepare 单独调用。编译后 `check` / Windows 构建运行完整 Market 检查；macOS 构建编译同一产品市场。跨模块顺序见[模块总览](../README.md)。

市场服务源码已原生支持共享 Registry 路由，旧部署覆盖及副本入口已移除。服务部署走[部署 · 插件市场](../../../.github/workflows/deploy-plugin-market.yml)，不由 Desktop 装配触发。

## 验证与诊断

在仓库根目录运行：

| 命令 | 检查什么 |
| --- | --- |
| `yarn test:build market` | 外层覆盖、真实入口装配和本地 SQLite 权限回归；不联网、不安装包、不启动 Electron |
| `yarn market:check` | 产品目录与生成清单一致性 |
| `yarn test:market` | 外层市场服务及部署脚本；不部署 |
| `yarn product:overlays market --check` | 覆盖记录与关联源码 pin；变化待复查时返回失败，不自动更新基线 |

完整 staging 中执行 `yarn workspace dsh-community-market check`，才会运行复制进去的 TypeScript / TSX 功能用例。测试文件不承担局部覆盖装配；更新后的覆盖应从新上游副本通过 prepare 应用。

三个诊断脚本仅手动执行，需要已编译 staging 和联网，可用 `PRODUCT_STAGE_NAME=desktop-<名称>` 指定隔离目录：

| 脚本 | 检查什么 |
| --- | --- |
| [market-live-regression.mjs](market-live-regression.mjs) | 公开目录、兼容域名、元数据和归档摘要，以及临时 Profile 的真实安装、更新检查和卸载 |
| [market-private-install-regression.mjs](market-private-install-regression.mjs) | 从公开测试包获取归档，在 localhost / SQLite 夹具中验证真实 pnpm 安装、Key 传递和撤权 |
| [market-agent-cli-regression.mjs](market-agent-cli-regression.mjs) | 新建 DSH_HOME，验证原生 CLI 的私有包路由限制及显式指定共享路由后的安装、移除 |

诊断不发布包、不修改生产权限，也不使用用户 Profile。自动化通过仍需另做真实宿主视觉、账户权限及安装验收；具体缺口保留在 review.json。
