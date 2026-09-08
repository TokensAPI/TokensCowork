# Desktop product build

本目录把只读的 Desktop、DeepSeek Harness 和产品插件组装为 TokensCowork。
所有产品改写只能发生在生成目录 `.build/desktop/`，不得修改 `desktop/`、
`desktop/deepseek-harness/` 或 `plugins/` 子模块工作树。

## 目录

每个目录只回答一个问题——这类文件被谁、在什么时机调用:

```text
build/
├─ desktop-build.mjs   # 总调度(唯一知道执行顺序的地方):check、Windows、macOS
├─ product.yarn.lock   # 产品固定依赖图
├─ steps/              # 流程步骤:被调度器/脚本按序执行
├─ overlays/           # 领域覆盖:被 steps 调用的纯函数改写模块(见其 README)
├─ verify/             # 门禁:只读幂等校验,任意时点可跑
├─ hooks/              # 被外部工具(electron-builder 等)回调的
└─ assets/             # 静态输入素材,由 steps 复制/读取
```

## 命名规则(全部可执行文件同一语法)

`<对象/位置>-<动词>[-<限定>].mjs` —— 名词领头,一眼可见"在哪里、做什么";
目录内按字母排序即按领域聚簇(staging-*、market-*、mac* 各成一组)。

1. 对象段点名作用位置:作用于 staging 的显式以 `staging-` 开头
   (staging-prepare、staging-runtime-patch、staging-branding-verify);
   仓库级用 repo-,产品级用 product-,打包产物用 packaged-。
2. 动词收尾,封闭表:fetch / prepare / patch / compile / prune /
   configure / refresh / build / resolve / verify / smoke / overlay / sign。
3. 覆盖库以 `-overlay` 收尾(branding-overlay、market-auth-overlay);
   市场主题在 overlays/market/ 下以 `market-` 开头。
4. `-verify` 结尾为 CI 门禁,`-smoke` 结尾为手动诊断,都在 verify/。
5. 单测同名同目录 `<name>.test.mjs`;`assets/` 下的素材数据用纯名词,
   是唯一不带动词的文件。
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
  Profile 和最终运行时验收，然后生成 unsigned NSIS x64 安装包。安装 smoke
  使用上一稳定版模拟占用文件，确认失败升级不污染旧版、解除占用后可自动升级。
- macOS 两个架构在各自原生 runner 上构建，验证架构、签名、公证状态和 DMG。
- 发布任务只汇总安装包、SHA256、插件清单和 BUILD-INFO，不重新构建产品。

Windows Desktop 必须编译两次：先以原始 DSH 身份通过上游专项测试，再注入
TokensCowork 品牌生成最终产品。两个 macOS 架构也必须使用不同原生 runner。
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
排查 Action 失败或显式验证本机打包环境。快速检查允许子模块保留本地开发改动；
完整检查和打包会要求实际进入产品的源码子模块保持干净。

## 修改规则

1. 版本、品牌、Desktop pin 和默认插件写入顶层 `product.json`。
2. 产品加工只修改 staging；子模块保持只读并固定到 Git commit。
3. 插件进入产品前必须通过完整生产依赖许可证检查。
4. 运行时收在 app.asar 内（smartUnpack 只解原生模块）：不得让普通模块以真实
   文件镜像解包（afterPack 门禁拒绝），需要真实文件语义的健康检查一律走
   patch-runtime 补丁并由 verify-package 验收。
5. 构建产物、凭据、证书、API Key 和本地运行数据不得提交。
6. 流程或路径变化必须同步更新顶层命令、GitHub workflow 和本文档。
