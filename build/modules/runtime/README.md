# 运行时覆盖（runtime）

负责 DSH 版本对齐、打包 pnpm 版本、首次启动、GUI stderr、外部浏览器登录桥、RPC 作用域、摘要压缩和联网搜索插件的设置接口。
运行时版本以 `product.json` 的 `desktop.runtimeVersion` 为准；覆盖只写入生成的 staging，源码子模块保持只读。

## 文件职责

| 文件 | 负责什么 |
| --- | --- |
| [overlays.mjs](overlays.mjs) | 登记表：16 条覆盖的阶段、目标文件、原因与删除条件 |
| [runtime-version-overlay.mjs](runtime-version-overlay.mjs) | 统一 DSH resolutions、Yarn 冷却豁免与产品插件依赖；client-connection RPC 作用域；联网搜索插件的 DSH 0.2 设置适配 |
| [pnpm-version-overlay.mjs](pnpm-version-overlay.mjs) | 打包 pnpm 11.8.0 → 11.28.5：工作区依赖、根 resolutions、THIRD_PARTY_NOTICES 与 package.spec 版本断言 |
| [assets/pnpm@11.28.5.patch](assets/pnpm@11.28.5.patch) | 上游 Desktop 06446375 的 pnpm 补丁原样（minimumReleaseAge 为 0 或非数字时关闭年龄检查），写入 staging 的 `patches/` |
| [pnpm-exit-regression.mjs](pnpm-exit-regression.mjs) | 手动：用装配出的插件管理器 `runProfilePnpm` 驱动打包 pnpm，验证安装/卸载/更新打出 Done 后按时退出 |
| [desktop-runtime-overlay.mjs](desktop-runtime-overlay.mjs) | 跳过页面级首次向导并写入 skip 标记、Windows GUI stderr 容错、CLI smoke 与 Windows 测试 URL 适配 |
| [open-external-overlay.mjs](open-external-overlay.mjs) | 为 tokens-login 在 desktopRuntime 桥上增加仅限 HTTPS / 回环 HTTP 的 openExternal |
| [mask-secrets-overlay.mjs](mask-secrets-overlay.mjs) | 宿主日志不把 `code` 当密钥：错误码可读，auth_code / authorization_code 与 URL 查询串照旧脱敏；同步上游 diagnostics.spec |
| [compaction-overlay.mjs](compaction-overlay.mjs) | 摘要任务独立系统提示、历史作为引用数据、拒绝无效 checkpoint |
| [staging-compaction-smoke.mjs](staging-compaction-smoke.mjs) | runtime-patch 末尾自动调用，用已安装包验证压缩与 replay |
| [staging-rpc-smoke.mjs](staging-rpc-smoke.mjs) | `build.mjs` 在运行时适配后调用，用真实 Cordis 作用域验证 RPC 注册与释放 |
| `*.test.mjs` | 外层覆盖回归，直接对照固定上游与插件输入 |
| [review.json](review.json) | pin 基线与验证证据 |

## 执行顺序

1. `staging-prepare.mjs`：版本与依赖对齐 → 打包 pnpm 版本与补丁 → 首次向导 → stderr → CLI smoke / 测试 URL → 外部浏览器登录桥。
2. 安装依赖后 `staging-runtime-patch.mjs`：RPC 作用域、摘要压缩（可重复执行），随后压缩 smoke；`build.mjs` 再跑 RPC smoke。
3. `staging-plugins-compile.mjs` 编译插件后适配联网搜索设置，避免插件构建覆盖适配结果。

## 验证命令

| 命令 | 检查什么 |
| --- | --- |
| `yarn test:build runtime` | 覆盖代码回归；不安装依赖、不启动 Electron |
| `yarn product:overlays runtime --check` | 记录完整性与关联 pin；变化待复查时返回失败 |
| `node build/modules/runtime/pnpm-exit-regression.mjs [--stage <dir>] [--pnpm <dir>] [--live]` | 装配后手动跑：本地夹具（默认）或真实 Registry（`--live`，读 `~/.npmrc`）上安装、卸载、先卸载再安装的更新，每步退出码 0、Done 后按时退出、package.json 与锁文件正确；`--pnpm` 指向 11.8.0 可复现卡住 |

真实模型压缩、登录浏览器跳转和设置界面仍需在实际宿主中验收。跨模块顺序见[模块总览](../README.md)。
