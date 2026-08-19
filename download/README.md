# TokensHarness 下载页

这是一个无需构建工具的静态下载页，安装包默认来自 GitHub Releases。

## 编辑页面

集中修改 [`site-config.js`](./site-config.js) 即可更新产品名、标题、说明、GitHub 仓库和页脚文案。

页面支持中英文切换。中文内容使用顶层字段，英文内容位于 `english` 对象；用户选择的语言会保存在浏览器中。

也可以在本地访问 `index.html?edit=1`，点击右上角“编辑页面”预览文案。编辑结果只保存在当前浏览器；点击“导出配置”会生成新的 `site-config.js`，确认后替换仓库里的文件。

## GitHub Release 约定

页面调用 GitHub 公共 API 获取最新 Release，并识别以下文件名：

- `*-windows-amd64-installer.exe`
- `*-macos-arm64-installer.dmg`
- `*-macos-amd64-installer.dmg`

当前仓库的 Release 工作流已经使用这些命名。若 API 不可用、仓库私有或尚未发布 Release，下载按钮会安全降级到仓库的 `/releases/latest` 页面。

页面右上角的版本下拉框会自动列出公开的历史 Releases。选择旧版本后，平台下载按钮、发布日期和发布说明会同步切换到对应版本。

如需临时使用固定下载链接，可在 `site-config.js` 的 `downloadOverrides` 中覆盖某个平台。

## 本地预览

在仓库根目录运行任意静态文件服务器，例如：

```powershell
npx serve download
```

然后打开终端显示的本地地址。不要直接双击 HTML 文件，因为部分浏览器会限制本地文件调用 GitHub API。

## 部署

仓库通过 `.github/workflows/pages.yml` 自动部署本目录。Pages 的 **Source** 必须设置为 **GitHub Actions**；`master` 分支的下载页文件变化后会自动运行 `Deploy Download Page`，也可以从 Actions 页面手动触发。默认访问地址为：

```text
https://tokensapi.github.io/tokens_TokensHarness_code/
```

页面不需要服务端和构建步骤，也可以部署到 Cloudflare Pages、Vercel 或现有网站服务器。
