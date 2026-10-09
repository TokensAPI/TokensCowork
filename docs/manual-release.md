# TokensCowork 手动构建与发布指南

本文面向需要新增或升级内置插件、在本地验证安装包，或手动发布 TokensCowork 新版本的维护者。

> 仓库是只负责组装和构建的 Superproject。不要直接修改 `desktop/` 或 `plugins/` 下的子模块工作区；插件代码应先在插件自身仓库提交，再由本项目固定提交 SHA。

## 发布方式

- **本地手动打包**：在当前操作系统生成验证用安装包，不会自动创建 GitHub Release。
- **构建预发布**：推送 `v*` Tag，由 GitHub Actions 构建 Windows AMD64、macOS ARM64 和 macOS AMD64，通过后创建预发布并更新下载页。
- **晋级正式发布**：验收已有预发布并补齐上一正式版以来的完整说明后，运行 `Promote Desktop Release`，输入原标签；复用已验收的安装包，不重新构建。

新增插件后先构建预发布，完成验收后再晋级。

### 手动执行内置插件回归

在仓库根目录运行，测试指定产品标签固定的源码：

```powershell
corepack yarn test:plugins --ref v0.5.19
```

不传 `--ref` 时使用当前 HEAD 的产品清单；加 `--plan` 可只查看版本和测试入口。先递归初始化子模块，并准备 Node.js、npm、Corepack 与 tar。

命令优先调用插件已有的 `test:cases`，没有该入口则调用 `test`；没有测试脚本的插件列为 `not-configured`，暂时不补测试，也不算测试通过。固定提交的隔离检出、依赖安装、宿主夹具和报告全部位于 `.build/plugin-tests/`，不会改动源码子模块。联网搜索和模型插件所需的固定 Harness 依赖与宿主运行时也会自动准备。

也可在 GitHub Actions 手动运行 `Test Product Plugins`，输入 `ref`（例如 `v0.5.19`），只运行回归而不晋级版本。

报告记录每个插件的版本、源码提交、测试入口和结果；失败、依赖准备失败或测试报告包含跳过、TODO、未完成用例时命令返回非零。`Promote Desktop Release` 使用同一命令测试待晋级标签，全部已配置测试通过后才执行晋级；报告保存在 Actions 附件中。晋级仍复用原安装包，不重新构建或公证，发布说明仍须合并上一稳定版以来的内容。

模型插件的功能入口以 CSV 中的必需用例为准，底层测试中的平台限定用例仍按插件自身条件运行；报告额外保留功能用例统计及底层通过、失败、跳过数量，不能将平台跳过或自动化检查称为人工验收。

## 1. 准备环境

需要 Git、Git Bash、Node.js 22.19 或更高版本，以及 Corepack。

```powershell
git submodule update --init --recursive
corepack yarn product:check
```

`product:check` 核对 `product.json` 的提交与 Git 索引中的 gitlink、实际检出和清单；发布使用 `--require-clean` 核对参与构建的源码洁净性。不要为此删除协作者正在开发的子模块修改，改用独立检出。完整升级注意事项见 [上游升级检查指南](upstream-upgrade.md)。

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

必须把生成的 `build/pipeline/product.yarn.lock` 与插件配置一起提交。发布构建使用 immutable lockfile，锁文件未同步会直接失败。

## 5. 设置产品版本

`VERSION` 是唯一可手动设置的版本源。例如发布 `0.5.14`：

```powershell
$env:VERSION = "0.5.14"
bash scripts/set-version.sh
Remove-Item Env:VERSION
corepack yarn product:version-check
```

新发布从 `product.json` 自动生成 clean/bundled 发行标记，带插件版本也可以使用 `x.y.0`；无需另行维护发行类型。下载页仅对无标记的历史 Release 沿用 `x.y.0` 纯净版约定。发行类型与 GitHub 的 stable/prerelease 状态相互独立。

## 6. 编写发布说明

先复制 [完整发布模板](releases/TEMPLATE.md)，按模板末尾注释中的填写规则编写中英文更新、下载、安装和验证信息。无内容的更新分类可以删除，验证状态必须与实际执行范围一致。

创建 `docs/releases/v0.5.14.md`，首行必须是：

```markdown
# TokensCowork v0.5.14
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
  --version 0.5.14 `
  --file docs/releases/v0.5.14.md --format full

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
git add .gitmodules plugins/tokens_NewPlugin_code product.json build/pipeline/product.yarn.lock
git commit -m "feat(product): bundle new plugin" `
  -m "登记并默认启用新插件，同步固定提交和产品依赖锁。"

git add VERSION package.json product.json docs/releases/v0.5.14.md
git commit -m "build(release): prepare 0.5.14" `
  -m "同步 0.5.14 产品版本与发布说明，为正式构建做好准备。"

git push origin master
```

不要把本地缓存、安装包、密钥、签名证书或与本次发布无关的修改带入提交。

## 9. 创建 Tag 并构建预发布

确认 `master` 已经推送，且 `HEAD` 正是要发布的提交：

```powershell
git status --short --branch
git log -1 --oneline
git ls-remote origin refs/heads/master
```

创建并推送 Tag：

```powershell
git tag -a v0.5.14 -m "TokensCowork v0.5.14"
git push origin v0.5.14
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

## 10. 晋级正式发布

完成候选版验收后，先更新对应版本 Markdown，汇总上一正式版以来的变化，并将中英文“完整变更”链接改为该正式版至当前版本的范围。提交并推送说明，再执行：

```powershell
node scripts/promote-release.mjs v0.5.14
gh workflow run promote-release.yml --ref master -f tag=v0.5.14
```

第一个命令仅预检，第二个工作流复用现有标签和安装包，更新说明并晋级为正式版。缺失平台附件、说明不完整或版本低于最新正式版时拒绝晋级。不要为变更发布状态移动标签或重新构建。

## 11. 历史版本保留

`v0.4.0` 之前的 `v0.1.x`、`v0.2.x`、`v0.3.x` 各保留版本号最新的三个已发布 Release，并同步保留对应 Markdown。Git 标签和提交历史保留。

```powershell
node scripts/prune-legacy-releases.mjs
node scripts/prune-legacy-releases.mjs --apply
```

第一个命令仅列出清理计划；第二个命令删除旧 Releases 及其附件和 Markdown，执行前在 `.build/diagnostics/` 保存元数据与 Markdown。该备份不包含安装包；需要保留旧二进制时应先自行归档。脚本不清理草稿、带候选后缀的版本或 `v0.4.0` 及后续版本。

## 12. 失败处理

- 构建失败后先查看失败 Job 和具体 Step，不要只重试失败流程。
- 尚未创建 Release 时，修复代码后仍需要让 Tag 指向新的已验证提交；这会改写远程 Tag，必须先确认没有人已经下载或基于旧 Tag 继续工作。
- Release 已经对外发布后，不要移动或覆盖已有 Tag；应当增加一个新的修复版本。
- 不要使用 `git push --force` 覆盖 `master`。

## 快速检查清单

- [ ] 插件自身仓库已提交可发布代码和运行时产物。
- [ ] 插件子模块与 `product.json` 使用同一提交 SHA。
- [ ] 默认插件的完整生产依赖许可证已通过。
- [ ] `build/pipeline/product.yarn.lock` 已刷新并提交。
- [ ] `VERSION`、`package.json` 和 `product.json` 版本一致。
- [ ] `docs/releases/vx.y.z.md` 已创建并通过校验。
- [ ] `product:check-desktop` 已通过。
- [ ] `master` 已推送，Tag 指向需要发布的提交。
- [ ] GitHub Actions 三平台构建、Release 和下载页都已成功。
