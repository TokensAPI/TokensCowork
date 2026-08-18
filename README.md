# tokens_TokensHarness_code

这是 DSH Desktop 产品的纯构建 Superproject。顶层不复制 Desktop、DeepSeek Harness 或插件业务代码，只固定子模块版本并持有组装、校验和跨平台发布脚本。

## 目录

```text
desktop/                     Desktop 子模块
  deepseek-harness/          Desktop 自带的递归 DSH 子模块
plugins/dsh-vision-router/   插件源码子模块
build/                       临时组装与构建脚本
VERSION                      唯一可编辑的产品版本源
product.json                 产品身份、固定提交和默认插件清单
docs/releases/               固定发布说明与模板
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
corepack yarn product:dist:mac-unsigned
```

`product:dist:mac-unsigned` 是当前 GitHub Actions 使用的 DMG 构建入口，通过 `DSH_MAC_ARCH=arm64|x64` 选择原生 Runner 架构。`product:dist:mac` 保留为签名和公证的正式发布入口，需要仓库 Secrets：`MAC_CERT_P12_BASE64`、`CSC_KEY_PASSWORD`、`MACOS_SIGN_IDENTITY`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

`Desktop Build` 工作流支持手动运行或由 `v*` 标签触发。Actions artifact 包含 Windows amd64、macOS arm64、macOS amd64 安装包及各平台的 SHA-256 和 `BUILD-INFO.txt`。正式 GitHub Release 只包含三个安装包和统一 SHA-256 文件；当前 CI 产物会明确标记为未签名。

## 版本与发布说明

`VERSION` 是唯一可编辑的产品版本源。运行 `VERSION=x.y.z bash scripts/set-version.sh` 将版本同步到 `package.json` 和 `product.json`；`bash scripts/set-version.sh --check` 校验重复元数据。

每个正式版本必须提供 `docs/releases/vx.y.z.md`。发布前由 `scripts/validate-release-notes.mjs` 检查固定标题和“本次更新、下载说明、安装说明、验证结果、已知限制、完整变更”六个章节，Release 直接使用该文件，不自动生成正文。

## 插件策略

插件必须先作为 `plugins/` 下的 Git 子模块固定提交，再登记到 `product.json`。`enabledByDefault: true` 的插件会在临时 staging 中作为 Yarn workspace 加入 Desktop，并把插件的 DSH patch 追加到 Desktop 产品层。

启用或升级默认插件后运行 `corepack yarn product:refresh-lock`，提交生成的 `build/product.yarn.lock`。普通 CI 和发布构建只接受 immutable lockfile。

`dsh-vision-router` 当前作为固定源码候选存在，但默认不分发，因为它依赖 GPL-2.0 的 `potrace`。接受相应许可证义务或上游移除该依赖后，才能将其改为默认启用并重新验证安装包许可证。
