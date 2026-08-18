# tokens_TokensHarness_code

这是 DSH Desktop 产品的纯构建 Superproject。顶层不复制 Desktop、DeepSeek Harness 或插件业务代码，只固定子模块版本并持有组装、校验和跨平台发布脚本。

## 目录

```text
desktop/                     Desktop 子模块
  deepseek-harness/          Desktop 自带的递归 DSH 子模块
plugins/dsh-vision-router/   插件源码子模块
build/                       临时组装与构建脚本
product.json                 固定提交和默认插件清单
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

`product:dist:mac-unsigned` 是当前 GitHub Actions 使用的 arm64 DMG 构建入口。`product:dist:mac` 保留为签名和公证的正式发布入口，需要仓库 Secrets：`MAC_CERT_P12_BASE64`、`CSC_KEY_PASSWORD`、`MACOS_SIGN_IDENTITY`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

`Desktop Build` 工作流支持手动运行或由 `v*` 标签触发。它会上传带产品版本的 Windows amd64、macOS arm64 安装包、SHA-256 校验文件和 `BUILD-INFO.txt`；当前 CI 产物会明确标记为未签名。

## 插件策略

插件必须先作为 `plugins/` 下的 Git 子模块固定提交，再登记到 `product.json`。`enabledByDefault: true` 的插件会在临时 staging 中作为 Yarn workspace 加入 Desktop，并把插件的 DSH patch 追加到 Desktop 产品层。

启用或升级默认插件后运行 `corepack yarn product:refresh-lock`，提交生成的 `build/product.yarn.lock`。普通 CI 和发布构建只接受 immutable lockfile。

`dsh-vision-router` 当前作为固定源码候选存在，但默认不分发，因为它依赖 GPL-2.0 的 `potrace`。接受相应许可证义务或上游移除该依赖后，才能将其改为默认启用并重新验证安装包许可证。
