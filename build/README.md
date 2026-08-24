# Desktop product build

本目录负责把只读的 Desktop、DeepSeek Harness 和产品插件组装成
TokensHarness。所有产品改写只能发生在生成目录 `.build/desktop/`，不得修改
`desktop/`、`desktop/deepseek-harness/` 或 `plugins/` 子模块工作树。

## 目录职责

```text
build/
├─ build-desktop.mjs       # check、Windows 和 macOS 的统一调度入口
├─ product.yarn.lock       # 完整产品 workspace 的固定依赖图
├─ assembly/               # 创建 staging，并应用产品配置
├─ plugins/                # 获取、编译和裁剪产品插件
├─ verify/                 # 源布局、品牌和最终安装包门禁
└─ macos/                  # macOS 签名模式与打包 hook
```

- `assembly/prepare.mjs`：删除并重建 `.build/desktop/`，复制只读来源，注入默认
  插件、产品补丁和固定锁文件。
- `assembly/configure.mjs`：在 staging 中写入产品版本、名称、appId、安装器配置
  和运行时品牌。
- `assembly/refresh-lock.mjs`：重新装配产品 workspace 并更新
  `product.yarn.lock`。
- `plugins/fetch-artifacts.mjs`：下载并校验 `product.json` 声明的固定插件制品。
- `plugins/compile.mjs`：编译声明了 `runtimeBuild` 的插件运行时入口。
- `plugins/prune.mjs`：只保留插件分发所需的运行时、声明和许可证文件。
- `verify/layout.mjs`：检查版本、Gitlink、子模块 commit 和插件声明。
- `verify/branding.mjs`：检查 staging 源码与编译输出中的产品品牌。
- `verify/package.mjs`：检查最终平台安装包及其解包运行时。
- `macos/auto.mjs`：根据完整凭据集选择正式签名或 ad-hoc 构建。

## 执行流程

完整检查和平台打包都从 `build-desktop.mjs` 开始，并先执行同一套干净装配：

```text
verify/layout
→ plugins/fetch-artifacts
→ assembly/prepare
→ yarn install --immutable
→ plugins/compile
→ plugins/prune
→ 生产依赖许可证检查
```

公共阶段完成后按模式分支：

- `check`：检查 Fabric 和 Market，配置产品，编译 Desktop，运行类型、闭包、CLI、
  Loader、Profile 和品牌门禁；不生成安装包。
- `win`：先按上游身份运行 Windows 专项包测试，再注入 TokensHarness 品牌并
  重新编译，最后生成和检查 unsigned NSIS 安装包。x64 产物只排除其他 CPU 的
  原生二进制，以及 `node_modules` 中不参与运行的 source map 和 TypeScript 声明；
  JavaScript 运行时、CLI、Worker、插件与 Profile 物理文件树保持完整。
- `mac-unsigned`：在目标架构原生 macOS runner 上生成 ad-hoc 签名 DMG。
- `mac`：使用完整 Developer ID 和 Apple 凭据执行签名及公证发布。

Windows 的品牌配置必须晚于上游专项测试。部分上游测试会验证原始 DSH 产品
身份，提前配置 TokensHarness 会把正常的产品改写误判为上游回归。

Windows 的安装提速不得通过缩小 `asarUnpack` 范围实现。最终包门禁会同时确认
x64 的 sharp、ripgrep、koffi、Node addon 和 node-pty 文件存在，其他架构不存在，
且完整 ASAR 物理镜像、包解析、CLI 与诊断 Worker 仍通过上游 afterPack 验收。

## 顶层命令

```text
product:check             只检查版本、Git pin 和产品声明
product:prepare           只重建 staging，不安装依赖
product:refresh-lock      依赖图变化时更新产品锁文件
product:check-desktop     干净装配并运行完整产品检查，不生成安装包
product:dist:win          生成本地 Windows 安装包
product:dist:mac:auto     生成本地 macOS 安装包
```

正式 Windows 和 macOS 安装包默认由 GitHub Action 在对应原生 runner 上生成。
本机通常只运行 `product:check`；发布前需要完整验证时运行一次
`product:check-desktop`。不要在完整命令前手动重复执行 `product:prepare`，因为
`build-desktop.mjs` 会重新进行干净装配。

## 修改规则

1. 产品版本、品牌、Desktop pin 和默认插件清单写入顶层 `product.json`。
2. 新的 staging 复制或产品配置逻辑放入 `assembly/`。
3. 插件获取、编译和分发裁剪逻辑放入 `plugins/`。
4. 不改变产物的只读断言放入 `verify/`。
5. macOS 独有的签名选择和 Electron Builder hook 放入 `macos/`。
6. `build-desktop.mjs` 只负责顺序、模式分支和子进程调度，避免继续堆入具体改写。
7. 不为单个历史故障创建独立脚本；优先放入现有稳定职责中。
8. 只有默认插件或生产依赖图变化时才刷新并提交 `product.yarn.lock`。

任何路径调整都必须同时更新顶层 `package.json`、GitHub workflow、脚本间引用和
本文档，并至少通过 `product:check`、相关脚本测试及 `product:check-desktop`。
