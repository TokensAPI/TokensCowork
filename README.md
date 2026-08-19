# tokens_TokensHarness_code

这是 DSH Desktop 产品的纯构建 Superproject。顶层不复制 Desktop、DeepSeek Harness 或插件业务代码，只固定子模块版本并持有组装、校验和跨平台发布脚本。

## 目录

```text
desktop/                     Desktop 子模块
  deepseek-harness/          Desktop 自带的递归 DSH 子模块
plugins/                     插件源码子模块
build/                       临时组装与构建脚本
VERSION                      唯一可编辑的产品版本源
product.json                 产品身份、固定提交和默认插件清单
docs/releases/               固定发布说明与模板
download/                    可配置的桌面端下载页
.github/workflows/           Windows、macOS 与 Release 构建
```

## 初始化

```powershell
git submodule update --init --recursive
corepack yarn product:check
```

## 构建

构建脚本把 `desktop/` 和默认启用的插件复制到 `.build/desktop/` 后组装，因此不会修改任何子模块工作区。

```powershell
corepack yarn product:check-desktop
corepack yarn product:dist:win
corepack yarn product:dist:mac:auto
```

`product:dist:mac:auto` 是本地和 GitHub Actions 的统一 DMG 入口，通过 `DSH_MAC_ARCH=arm64|x64` 选择原生 Runner 架构。当 `MAC_CERT_P12_BASE64`、`CSC_KEY_PASSWORD`、`MACOS_SIGN_IDENTITY`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`和 `APPLE_TEAM_ID` 全部存在时，它执行 Developer ID 签名、Apple 公证和 staple；全部未配置时自动生成 ad-hoc 签名版本；只配置一部分凭据时立即失败。

`product:dist:mac` 和 `product:dist:mac-unsigned` 保留为明确的底层入口。ad-hoc 流程会在 DMG 生成前对 Electron `.app` 及其嵌套组件签名并执行严格校验；正式流程会额外执行 Gatekeeper 评估和 staple 校验。

`Desktop Build` 工作流支持手动运行或由 `v*` 标签触发。Actions artifact 包含 Windows amd64、macOS arm64、macOS amd64 安装包及各平台的 SHA-256 和 `BUILD-INFO.txt`。正式 GitHub Release 只包含三个安装包和统一 SHA-256 文件；macOS `BUILD-INFO.txt` 会记录 `developer-id-notarized` 或 `ad-hoc` 的实际签名模式。

## Windows 静默卸载

`corepack yarn product:uninstall:win` 用于反复装卸测试。加 `--purge-data` 时一并清除
`%APPDATA%\TokensHarness\`，默认保留。

保留用户数据是产品约定，两头都得守住：构建侧不设
`nsis.deleteAppDataOnUninstall`，因为它是**编译期**开关，写进安装包后运行期
再也关不掉；`build/verify-product-branding.mjs` 和 `build/verify-package.mjs` 会拦下它变回
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

## 版本与发布说明

`VERSION` 是唯一可编辑的产品版本源。运行 `VERSION=x.y.z bash scripts/set-version.sh` 将版本同步到 `package.json` 和 `product.json`；`bash scripts/set-version.sh --check` 校验重复元数据。

每个正式版本必须提供 `docs/releases/vx.y.z.md`。发布前由 `scripts/validate-release-notes.mjs` 检查固定标题和“本次更新、下载说明、安装说明、验证结果、已知限制、完整变更”六个章节，Release 直接使用该文件，不自动生成正文。

## 下载页

`download/` 是独立的静态下载页。GitHub Pages 的 Source 使用 **GitHub Actions**，`.github/workflows/pages.yml` 会在 `master` 分支的下载页文件变化后自动发布，也支持手动运行 `Deploy Download Page`。

仓库 Secret `RELEASE_TOKEN` 必须由指定发布账号创建并具备仓库 Contents 写权限。正式 Release 使用该 Token，而不是 `github.token`，因此发布者显示为指定 GitHub 用户。

## 插件策略

插件必须先作为 `plugins/` 下的 Git 子模块固定提交，再登记到 `product.json`。`enabledByDefault: true` 的插件会在临时 staging 中作为 Yarn workspace 加入 Desktop，并把插件的 DSH patch 追加到 Desktop 产品层。

启用或升级默认插件后运行 `corepack yarn product:refresh-lock`，提交生成的 `build/product.yarn.lock`。普通 CI 和发布构建只接受 immutable lockfile。
