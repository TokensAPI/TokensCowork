# TokensCowork 手动构建与发布指南

本文面向需要新增或升级内置插件、在本地验证安装包，或手动发布 TokensCowork 新版本的维护者。

> 仓库是只负责组装和构建的 Superproject。不要直接修改 `desktop/` 或 `plugins/` 下的子模块工作区；插件代码应先在插件自身仓库提交，再由本项目固定提交 SHA。

## 发布方式

- **本地手动打包**：在当前操作系统生成验证用安装包，不会自动创建 GitHub Release。
- **正式发布**：推送 `v*` Tag，由 GitHub Actions 构建 Windows AMD64、macOS ARM64 和 macOS AMD64，通过后自动创建 Release 并更新下载页。

新增插件后需要对外发布时，使用第二种方式。

## 1. 准备环境

需要 Git、Git Bash、Node.js 22.19 或更高版本，以及 Corepack。

```powershell
git submodule update --init --recursive
corepack yarn product:check
```

`product:check` 必须确认 Desktop、DSH 和所有插件子模块都在 `product.json` 固定的提交上，且子模块工作区没有未提交修改。

## 2. 新增插件子模块

先确保插件自身仓库已经提交所有准备发布的代码，然后在本仓库根目录执行：

```powershell
git submodule add --name tokens-new-plugin `
  https://github.com/<owner>/<plugin-repository>.git `
  plugins/tokens_NewPlugin_code

git -C plugins/tokens_NewPlugin_code checkout <plugin-commit-sha>
```

记录完整的插件提交 SHA：

```powershell
git -C plugins/tokens_NewPlugin_code rev-parse HEAD
```

## 3. 登记产品插件

在 `product.json` 的 `plugins` 数组中添加一项：

```json
{
  "id": "tokens-new-plugin",
  "displayName": "新插件",
  "description": "插件功能介绍",
  "path": "plugins/tokens_NewPlugin_code",
  "repository": "https://github.com/<owner>/<plugin-repository>.git",
  "commit": "<plugin-commit-sha>",
  "package": "@tokens/dsh-new-plugin",
  "version": "0.1.0",
  "enabledByDefault": true,
  "patch": "cordis.patch.yml"
}
```

- `enabledByDefault: true` 表示插件会进入安装包。
- `enabledByDefault: false` 表示只记录插件来源，不会打进当前产品。
- 插件应提交可直接加载的 JavaScript 运行时产物，或在自身 `package.json` 中提供可复现的构建脚本。源码插件在产品清单中声明 `runtimeBuild.script` 与 `runtimeBuild.outputs`，产品只负责执行脚本并验证产物，不耦合 TypeScript、esbuild 等具体工具。
- 启用插件前，必须确认完整生产依赖许可证能通过 Desktop license gate。

## 4. 刷新产品锁文件

新增、升级或启用任何默认插件后执行：

```powershell
corepack yarn product:refresh-lock
```

必须把生成的 `build/product.yarn.lock` 与插件配置一起提交。发布构建使用 immutable lockfile，锁文件未同步会直接失败。

## 5. 设置产品版本

`VERSION` 是唯一可手动设置的版本源。例如发布 `0.3.1`：

```powershell
$env:VERSION = "0.3.1"
bash scripts/set-version.sh
Remove-Item Env:VERSION
corepack yarn product:version-check
```

下载页把 `x.y.0` 识别为纯净版。包含默认插件的普通版本不要使用 `x.y.0`；例如可以使用 `0.3.1`、`0.3.2`。

## 6. 编写发布说明

创建 `docs/releases/v0.3.1.md`，首行必须是：

```markdown
# TokensCowork v0.3.1
```

文件必须包含以下章节：

```markdown
## 本次更新
## 下载说明
## 安装说明
## 验证结果
## 已知限制
## 完整变更
```

下载页可以不展示其中某些章节，但发布校验仍要求文件结构完整。

```powershell
node scripts/validate-release-notes.mjs `
  --version 0.3.1 `
  --file docs/releases/v0.3.1.md

corepack yarn test:release-notes
```

## 7. 发布前验证

至少运行：

```powershell
corepack yarn product:check
corepack yarn product:check-desktop
```

`product:check-desktop` 会验证产品组装、Market、Desktop 编译与类型、CLI、Loader、Profile、运行时闭包和生产依赖许可证。

需要本地生成验证安装包时，在对应的原生系统执行：

```powershell
# Windows x64
corepack yarn product:dist:win
```

```bash
# macOS；当前 Mac 必须与目标架构一致
corepack yarn product:dist:mac:auto
```

产物位于 `.build/desktop/dsh-plugin-desktop/dist/`。`.build/` 是忽略的临时构建目录，不要提交安装包。

## 8. 提交并推送源码

先确认提交范围：

```powershell
git status --short
git diff --check
```

推荐把插件产品变更和版本准备拆成两个逻辑提交：

```powershell
git add .gitmodules plugins/tokens_NewPlugin_code product.json build/product.yarn.lock
git commit -m "feat(product): bundle new plugin" `
  -m "登记并默认启用新插件，同步固定提交和产品依赖锁。"

git add VERSION package.json product.json docs/releases/v0.3.1.md
git commit -m "build(release): prepare 0.3.1" `
  -m "同步 0.3.1 产品版本与发布说明，为正式构建做好准备。"

git push origin master
```

不要把本地缓存、安装包、密钥、签名证书或与本次发布无关的修改带入提交。

## 9. 创建 Tag 并自动发布

确认 `master` 已经推送，且 `HEAD` 正是要发布的提交：

```powershell
git status --short --branch
git log -1 --oneline
git ls-remote origin refs/heads/master
```

创建并推送 Tag：

```powershell
git tag -a v0.3.1 -m "TokensCowork v0.3.1"
git push origin v0.3.1
```

Tag 推送后，[`Build Desktop`](https://github.com/TokensAPI/TokensCowork/actions/workflows/release.yml) 会自动：

1. 校验版本号和发布说明。
2. 校验所有 Git pin、产品组装和生产依赖许可证。
3. 构建 Windows AMD64、macOS ARM64 和 macOS AMD64 安装包。
4. 创建正式 GitHub Release，上传三个安装包和 SHA-256 校验文件。
5. 触发 [`Deploy Download Page`](https://github.com/TokensAPI/TokensCowork/actions/workflows/pages.yml) 同步下载页数据。

发布入口：

- [GitHub Actions](https://github.com/TokensAPI/TokensCowork/actions)
- [GitHub Releases](https://github.com/TokensAPI/TokensCowork/releases)
- [TokensCowork 下载页](https://tokensapi.github.io/TokensCowork/)

## 10. 失败处理

- 构建失败后先查看失败 Job 和具体 Step，不要只重试失败流程。
- 尚未创建 Release 时，修复代码后仍需要让 Tag 指向新的已验证提交；这会改写远程 Tag，必须先确认没有人已经下载或基于旧 Tag 继续工作。
- Release 已经对外发布后，不要移动或覆盖已有 Tag；应当增加一个新的修复版本。
- 不要使用 `git push --force` 覆盖 `master`。

## 快速检查清单

- [ ] 插件自身仓库已提交可发布代码和运行时产物。
- [ ] 插件子模块与 `product.json` 使用同一提交 SHA。
- [ ] 默认插件的完整生产依赖许可证已通过。
- [ ] `build/product.yarn.lock` 已刷新并提交。
- [ ] `VERSION`、`package.json` 和 `product.json` 版本一致。
- [ ] `docs/releases/vx.y.z.md` 已创建并通过校验。
- [ ] `product:check-desktop` 已通过。
- [ ] `master` 已推送，Tag 指向需要发布的提交。
- [ ] GitHub Actions 三平台构建、Release 和下载页都已成功。
