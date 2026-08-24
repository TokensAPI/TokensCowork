# Desktop product build

本目录把只读的 Desktop、DeepSeek Harness 和产品插件组装为 TokensHarness。
所有产品改写只能发生在生成目录 `.build/desktop/`，不得修改 `desktop/`、
`desktop/deepseek-harness/` 或 `plugins/` 子模块工作树。

## 目录

```text
build/
├─ build-desktop.mjs   # check、Windows、macOS 调度入口
├─ product.yarn.lock   # 产品固定依赖图
├─ assembly/           # staging 与产品配置
├─ plugins/            # 插件获取、编译和裁剪
├─ verify/             # 布局、品牌和最终包验收
└─ macos/              # macOS 签名与打包 hook
```

## 构建流程

所有完整检查和平台打包都先执行同一套干净装配：

```text
检查版本、Git pin 和产品声明
→ 重建 .build/desktop
→ 注入默认插件和产品锁文件
→ yarn install --immutable
→ 编译并裁剪插件
→ 检查生产依赖许可证
```

正常发布流程：

```text
本机 product:check
→ 提交并推送版本
→ 触发 Build Desktop
→ Windows、macOS arm64、macOS amd64 并行构建
→ 全部通过后创建 GitHub Release
```

- Windows 在同一份 staging 中完成 Fabric、Market、Desktop、CLI、Loader、
  Profile、最终运行时和安装 smoke 验收，然后生成 unsigned NSIS x64 安装包。
- macOS 两个架构在各自原生 runner 上构建，验证架构、签名、公证状态和 DMG。
- 发布任务只汇总安装包、SHA256、插件清单和 BUILD-INFO，不重新构建产品。

Windows Desktop 必须编译两次：先以原始 DSH 身份通过上游专项测试，再注入
TokensHarness 品牌生成最终产品。两个 macOS 架构也必须使用不同原生 runner。
除此之外，不再运行独立的重复 Desktop 质量构建。

## 命令

```text
product:check             快速检查版本、Git pin 和产品声明
product:prepare           只重建 staging，不安装依赖
product:refresh-lock      默认插件或生产依赖变化时更新锁文件
product:check-desktop     本地完整检查，不生成安装包
product:dist:win          完整检查并生成 Windows 安装包
product:dist:mac:auto     生成当前架构的 macOS 安装包
```

正常发布时，本机只运行 `product:check`。其余完整命令只用于修改构建脚本、
排查 Action 失败或显式验证本机打包环境。

## 修改规则

1. 版本、品牌、Desktop pin 和默认插件写入顶层 `product.json`。
2. 产品加工只修改 staging；子模块保持只读并固定到 Git commit。
3. 插件进入产品前必须通过完整生产依赖许可证检查。
4. 不通过缩小 `asarUnpack` 破坏 CLI、Loader、Worker 或插件物理运行时。
5. 构建产物、凭据、证书、API Key 和本地运行数据不得提交。
6. 流程或路径变化必须同步更新顶层命令、GitHub workflow 和本文档。
