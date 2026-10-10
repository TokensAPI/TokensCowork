# 产品构建

将固定版本的 Desktop、DSH 和插件装配为 TokensCowork。子模块只读，产品加工只在生成的 `.build/desktop*` 中进行；版本和插件以 `product.json` 为准。

## 目录

```text
build/
├─ README.md
├─ build.mjs           完整检查 / 平台打包的统一调度入口
├─ pipeline/           装配步骤、依赖锁、跨模块校验
└─ modules/            上游行为覆盖，代码 / 测试 / 资源 / review.json 就近存放
   ├─ branding/        品牌、Logo、文案、旧数据迁移
   ├─ market/          市场来源、授权、插件更新、Registry 与部署适配
   ├─ runtime/         DSH 版本、启动、RPC、压缩及插件接口兼容
   ├─ updates/         桌面应用自身的版本更新
   └─ platform/        Windows ACL / 安装器、macOS 签名与架构
```

依赖方向：`build.mjs → pipeline → modules`。模块可使用共享路径工具，不反向调用构建流程。
不再另外分散 overlays、verify、hooks；只给资源建 `assets/`，不为每个模块重复建 steps/tests/utils。

命名采用小写 `kebab-case`：`对象-动作.mjs`；覆盖为 `*-overlay.mjs`，
检查为 `*-verify.mjs`，显式诊断为 `*-smoke.mjs / *-regression.mjs`。
`*.test.mjs` 是外层 Node 测试；`*.spec.ts` 和资源中的源码、签名回调复制到 staging 后执行，保留目标工具要求的格式。

## 执行过程

```text
检查产品与 Git pin → 获取固定插件产物 → 装配上游副本并应用模块覆盖
→ immutable 安装 → 运行时兼容检查 → 编译 / 裁剪插件 → 生产许可证门禁
→ 平台检查 / 品牌配置 / Desktop 编译 → 打包 → 产物验收 → CI 发布
```

- Windows 承担 Fabric、Market、Windows 包测试，再完成产品编译、品牌、类型、CLI、Loader、Profile 检查与 NSIS 打包。包测试所需的上游身份编译与后续产品编译仍保留。
- macOS 在原生 runner 只构建对应的 arm64 或 x64 包，完成配置、编译、品牌、原生依赖与签名检查；共享质量检查由同次 Windows 任务承担。三平台构建与插件回归共用 fail-fast 矩阵并行执行，任一任务失败取消其余任务，全部成功才发布。
- `check` 不生成安装包；本地开发脚本根据输入变化决定装配 / 编译，不调用安装包流程。
- 运行时检查包含摘要保护回归：只用内存中的测试会话，不联网、不读取 Key；真实模型测试需显式执行。
- 市场服务部署入口 `modules/market/market-routing-prepare.mjs` 独立生成服务副本，Desktop 打包不会调用它或部署市场。

## 常用命令

| 命令 | 用途 |
|---|---|
| `yarn product:plan` | 只显示 Windows 执行顺序，不安装、不写 staging |
| `node build/build.mjs mac --plan` | 查看其他目标计划；支持 check / win / mac / mac-unsigned |
| `yarn product:check` | 快速检查产品声明与 Git pin，不编译 |
| `yarn product:prepare` | 获取产物并装配；后续仍须 immutable 安装核对 |
| `yarn product:refresh-lock` | 依赖变化时刷新 pipeline/product.yarn.lock，不是每次发布前置 |
| `yarn test:build [模块]` | 外层测试，不安装、不启动 Electron、不访问生产市场 |
| `yarn test:ci` | 发布目标、回归门禁、互斥与下载页触发约束 |
| `yarn test:release` | 发布说明、晋级和附件清单的回归 |
| `yarn test:plugins --ref <tag或提交>` | 固定内置插件已有测试；没有入口的明确排除 |
| `yarn test:market` | 市场服务和部署脚本测试，不部署 |
| `yarn product:release:check` | CI 发布快速校验；只读，不发布或公证 |
| `yarn product:release:promote <tag>` | 正式说明和原资产只读校验；晋级由 CI 回归后执行 |
| `yarn product:overlays [模块] --check` | 查看覆盖记录，关联 pin 变化时提示复查并非零退出 |
| `yarn product:check-desktop` | 完整 staging 校验，不打包 |
| `yarn product:dist:win / product:dist:mac:auto` | 本地完整打包；正常发布交给 GitHub |
| `powershell -File scripts/dev-desktop.ps1 -Sandbox -StageName desktop-v050` | 隔离 Electron 功能测试 |

本地启动先自动同步产品生成清单（内容不变则不改时间戳），再使用 `repo-layout-verify.mjs --working-tree` 核对实际检出提交，允许外层子模块指针未暂存；默认检查与 CI 仍要求 Git 索引指针及生成清单一致，CI 另检查源码洁净性。

模块名同目录名。测试需要已检出的固定子模块；固定产物断言还需要已下载插件产物。
独立装配使用 `PRODUCT_STAGE_NAME=desktop-<名称>`，不要覆盖其他任务正在使用的 staging。

CI 文件、用途与触发条件统一见 [工作流表](../README.md#发布流程)。

升级时先看 [上游升级检查指南](../docs/upstream-upgrade.md)，覆盖台账见 [模块复查说明](modules/README.md)。结构测试与装配一致不代表跨平台安装和模型功能已验收，不能替代 CI、许可证门禁或真机测试。

macOS 正式发布在 GitHub Actions Repository Secrets 中配置五项：
`APPLE_CERT_BASE64`（含私钥的 Developer ID Application `.p12` 的 Base64）、
`APPLE_CERT_PASSWORD`（导出密码）、`APPLE_ID`（开发者账号邮箱）、
`APPLE_APP_PASSWORD`（该账号的 App 专用密码）、`APPLE_TEAM_ID`（团队 ID）。
证书名称从 `.p12` 自动读取并核对团队，无需另设签名身份 Secret。
五项均未配置时使用 ad-hoc 签名；部分配置时报错，完整配置时执行正式签名和公证。
私钥只由签名工具导入，解析名称仅提取公开证书；不要将凭据写入源码或日志。

正式签名后先保存应用 ZIP、SHA256 和 Apple 提交编号，公证最多等待 20 分钟。
`mac-notarization-{arm64,amd64}-版本` 构建附件保留 14 天，失败或取消时尽可能上传；被取消前尚未完成签名/提交的任务可能没有可恢复附件。
Apple 已收到的提交在 CI 停止后仍可能继续处理。

等待超时后，在 Actions 的 **查询/恢复 · macOS 公证** 中选择 `resume`，填写原“发布 · 桌面应用”run ID，选择要恢复的架构；仅查状态选择 `inspect`，无需填写运行 ID。
它核对原构建来源、产品版本、提交、架构与 ZIP 摘要，只查询原公证提交；Accepted 后恢复原签名应用、附加公证票据，生成并验收 DMG。
成功产物保存在该恢复任务的附件中，不自动发布 Release；三个平台的安装包与质量门禁全部成功后才能发布。
缺失、过期的附件或缺失提交编号会直接失败，不自动重新构建或提交公证。旧构建没有保存这些附件，无法追溯恢复。
