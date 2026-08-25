# tokens_TokensHarness_code

TokensHarness 桌面产品的纯构建 Superproject。顶层不复制 Desktop、DeepSeek Harness 或插件业务代码，只固定子模块提交、持有组装脚本，并负责跨平台打包、验收与发布。

所有产品加工只发生在生成目录 `.build/desktop/`；`desktop/` 与 `plugins/` 子模块始终保持只读。

## 目录

```text
desktop/                     Desktop 子模块（内含递归的 deepseek-harness 子模块）
plugins/                     插件源码子模块（每个插件一个独立仓库）
build/                       组装、验收与打包脚本
  assembly/                  staging 组装与产品配置改写
  plugins/                   插件获取、编译与运行时裁剪
  verify/                    布局、品牌与最终安装包验收
  macos/                     macOS 签名模式选择与打包 hook
  product.yarn.lock          产品固定依赖图（immutable）
scripts/                     版本同步、发布说明校验、插件清单生成、Windows 卸载
docs/
  manual-release.md          手动构建与发布指南（新增插件、本地打包、发新版）
  plugin-guide.md            插件开发从 0 到 1 教程
  releases/                  各版本发布说明与模板
download/                    静态下载页（GitHub Pages 自动部署）
.github/workflows/           Build Desktop（Windows + macOS + Release）与下载页部署
VERSION                      唯一可编辑的产品版本源
product.json                 产品身份、固定提交与默认插件清单
```

## 初始化

需要 Git、Git Bash、Node.js 22.19+ 和 Corepack。

```powershell
git submodule update --init --recursive
corepack yarn product:check
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `product:check` | 快速检查版本、Git pin 和产品声明 |
| `product:prepare` | 只重建 `.build/desktop` staging，不安装依赖 |
| `product:refresh-lock` | 默认插件或生产依赖变化后更新 `build/product.yarn.lock` |
| `product:check-desktop` | 本地完整检查，不生成安装包 |
| `product:dist:win` | 完整检查并生成 Windows NSIS 安装包 |
| `product:dist:mac:auto` | 生成当前架构的 macOS DMG（自动选择签名模式） |
| `product:uninstall:win` | Windows 静默卸载，用于反复装卸测试 |
| `test:uninstall` | Windows 卸载脚本单元测试 |

正常发布时本机只需要 `product:check`；其余完整命令用于修改构建脚本、排查 Action 失败或验证本机打包环境。

## 构建

构建脚本把 `desktop/` 和默认启用的插件复制到 `.build/desktop/` 后组装，因此不会修改任何子模块工作区。每次完整检查和打包都执行同一套干净装配：

```text
检查版本、Git pin 和产品声明
→ 重建 .build/desktop
→ 注入默认插件、产品品牌和 build/product.yarn.lock
→ yarn install --immutable
→ 编译并裁剪插件
→ 检查生产依赖许可证
→ 平台打包与最终验收
```

装配阶段还会施加产品覆盖：停用上游 `desktop-updates` 插件（它指向官方 DSH Desktop 下载源，与本产品无关），由内置的 `tokens-version-updates` 插件改从本仓库 GitHub Release 检查与下载更新。上游补丁条目一旦变动，装配会直接失败而不是静默漏掉覆盖。

macOS 打包细节：`product:dist:mac:auto` 是本地和 GitHub Actions 的统一 DMG 入口，通过 `DSH_MAC_ARCH=arm64|x64` 选择架构。当 `MAC_CERT_P12_BASE64`、`CSC_KEY_PASSWORD`、`MACOS_SIGN_IDENTITY`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID` 全部存在时执行 Developer ID 签名、公证和 staple；全部缺失时自动 ad-hoc 签名；只配置一部分时立即失败。`BUILD-INFO.txt` 记录实际采用的签名模式。

Windows 最终验收（`build/verify/package.mjs`）除品牌与原生架构检查外，还会拒绝产物中出现任何非 ASCII 文件名——NSIS 的解压组件不支持 UTF-8 zip 条目，此类文件会导致用户安装时报 "Failed to decompress files"（v0.3.7 事故）。

## 发布流程

推送 `v*` Tag 触发 `Build Desktop` 工作流：Windows amd64、macOS arm64、macOS amd64 并行构建，全部通过后创建 GitHub Release。Release 包含三个安装包、统一 SHA-256 文件和插件清单资产 `TokensHarness-<version>-plugins.json`（由 `scripts/generate-plugin-manifest.mjs` 从 `product.json` 生成，供下载页渲染"内置插件"）。

发布通道以 GitHub Release 的 `prerelease` 元数据为唯一事实来源：新版本默认作为 Pre-release 发布，验证通过后人工在 Release 页面取消 Pre-release 标记即进入稳定更新通道；一次性操作不写入 CI 流程。

仓库 Secret `RELEASE_TOKEN` 必须由指定发布账号创建并具备仓库 Contents 写权限，正式 Release 使用该 Token 而不是 `github.token`，因此发布者显示为指定 GitHub 用户。

> 新增插件、本地打包或手动发布的完整步骤见 [手动构建与发布指南](docs/manual-release.md)。

## 版本与发布说明

`VERSION` 是唯一可编辑的产品版本源。运行 `VERSION=x.y.z bash scripts/set-version.sh` 将版本同步到 `package.json` 和 `product.json`；`bash scripts/set-version.sh --check` 校验重复元数据。

每个版本必须提供 `docs/releases/vx.y.z.md`。发布前由 `scripts/validate-release-notes.mjs` 检查固定标题和"本次更新、下载说明、安装说明、验证结果、已知限制、完整变更"六个章节，Release 直接使用该文件，不自动生成正文。

## Windows 静默卸载

`corepack yarn product:uninstall:win` 用于反复装卸测试。加 `--purge-data` 时一并清除
`%APPDATA%\TokensHarness\`，默认保留。

保留用户数据是产品约定，两头都得守住：构建侧不设
`nsis.deleteAppDataOnUninstall`，因为它是**编译期**开关，写进安装包后运行期
再也关不掉；`build/verify/branding.mjs` 和 `build/verify/package.mjs` 会拦下它变回
`true`。运行侧则靠不传 `--delete-app-data`。注意卸载器只解析这个参数，
electron-builder 自升级时传的 `/KEEP_APP_DATA` 在 `uninstaller.nsh` 里根本没有解析分支，
写了也不会生效。

不要直接运行 `Uninstall TokensHarness.exe /S`：NSIS 卸载器会先把自身复制到 `%TEMP%`
再执行，好让它能删掉自己所在的目录，而副本的 `$INSTDIR` 是空的，于是 `RMDir /r $INSTDIR`
无事可做、流程照常走完并**返回 0** —— 表现为卸载成功但程序原封不动。

正解是 NSIS 的 `_?=<dir>`，它让卸载器就地运行并把 `$INSTDIR` 钉到真实安装路径。
该参数必须排在最后且路径不加引号，否则会静默退化回上述行为。就地运行后卸载器不再
自删，安装目录需由调用方收尾。因为退出码恰恰是本缺陷中失灵的一环，脚本一律以
文件系统状态判定成败。

覆盖升级还要多守一层：新版安装器在旧卸载器返回后检查实际安装目录，残留文件存在时
立即停止，不继续解压；新版卸载器在更新删除失败时返回非零状态。Windows Action 会从
上一稳定版开始，模拟文件占用、安全失败和解除占用后的自动升级。卸载辅助脚本按真实
GUID 注册记录发现产品，并在 `InstallLocation` 缺失时从 `UninstallString` 推导目录。

## 下载页

`download/` 是独立的静态下载页，展示各版本安装包与内置插件卡片。GitHub Pages 的 Source 使用 **GitHub Actions**，`.github/workflows/pages.yml` 会在 `master` 分支的下载页文件变化后自动发布，部署时还会把各 Release 的插件清单资产复制为同源文件（GitHub 资产域名不带 CORS 头，页面无法跨域直接读取）。详见 [download/README.md](download/README.md)。

## 插件策略

插件必须先作为 `plugins/` 下的 Git 子模块固定提交，再登记到 `product.json`。`enabledByDefault: true` 的插件会在 staging 中作为 Yarn workspace 加入 Desktop，并把插件的 DSH patch 追加到 Desktop 产品层；同时必须提供 `displayName` 和 `description`，缺失时插件清单生成会直接失败。

默认插件应提交可直接加载的 JavaScript 运行时产物，或自行提供可复现的 `build` 脚本。源码插件通过 `runtimeBuild.script` 声明统一构建入口和需要校验的 `outputs`；产品只在 staging 副本中执行插件脚本、验证产物并裁剪运行时文件，不理解插件使用的语言或编译器，也不修改插件子模块。

插件源码包名与产品运行时包名不同时，用 `sourcePackage` 固定上游身份，`package` 声明桌面最终加载的名称；重命名只发生在 staging 副本。

启用或升级默认插件后运行 `corepack yarn product:refresh-lock`，提交生成的 `build/product.yarn.lock`。普通 CI 和发布构建只接受 immutable lockfile。

> 想从零开发一个插件？见 [插件开发从 0 到 1](docs/plugin-guide.md)。

## 更多文档

- [手动构建与发布指南](docs/manual-release.md) — 新增插件子模块、本地打包验证、发布新版本
- [插件开发从 0 到 1](docs/plugin-guide.md) — DSH 插件开发教程
- [build/README.md](build/README.md) — 构建脚本内部结构、流程与修改规则
- [download/README.md](download/README.md) — 下载页配置、Release 命名约定与部署
