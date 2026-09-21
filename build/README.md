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
- macOS 在原生 runner 完成配置、编译、品牌、原生依赖与签名检查；共享质量检查由同次 Windows 任务承担。发布等待全部平台成功。
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
| `yarn product:overlays [模块] --check` | 查看覆盖记录，关联 pin 变化时提示复查并非零退出 |
| `yarn product:check-desktop` | 完整 staging 校验，不打包 |
| `yarn product:dist:win / product:dist:mac:auto` | 本地完整打包；正常发布交给 GitHub |
| `powershell -File scripts/dev-desktop.ps1 -Sandbox -StageName desktop-v050` | 隔离 Electron 功能测试 |

本地启动先自动同步产品生成清单（内容不变则不改时间戳），再使用 `repo-layout-verify.mjs --working-tree` 核对实际检出提交，允许外层子模块指针未暂存；默认检查与 CI 仍要求 Git 索引指针及生成清单一致，CI 另检查源码洁净性。

模块名同目录名。测试需要已检出的固定子模块；固定产物断言还需要已下载插件产物。
独立装配使用 `PRODUCT_STAGE_NAME=desktop-<名称>`，不要覆盖其他任务正在使用的 staging。

升级时先看 [上游升级检查指南](../docs/upstream-upgrade.md)，覆盖台账见 [模块复查说明](modules/README.md)。结构测试与装配一致不代表跨平台安装和模型功能已验收，不能替代 CI、许可证门禁或真机测试。
