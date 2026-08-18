# TokensHarness 下载页

这是一个无需构建工具的静态下载页，安装包默认来自 GitHub Releases。

## 编辑页面

集中修改 [`site-config.js`](./site-config.js) 即可更新产品名、标题、说明、GitHub 仓库和页脚文案。

也可以在本地访问 `index.html?edit=1`，点击右上角“编辑页面”预览文案。编辑结果只保存在当前浏览器；点击“导出配置”会生成新的 `site-config.js`，确认后替换仓库里的文件。

## GitHub Release 约定

页面调用 GitHub 公共 API 获取最新 Release，并识别以下文件名：

- `*-windows-amd64-installer.exe`
- `*-macos-arm64-installer.dmg`
- `*-macos-amd64-installer.dmg`

当前仓库的 Release 工作流已经使用这些命名。若 API 不可用、仓库私有或尚未发布 Release，下载按钮会安全降级到仓库的 `/releases/latest` 页面。

如需临时使用固定下载链接，可在 `site-config.js` 的 `downloadOverrides` 中覆盖某个平台。

## 本地预览

在仓库根目录运行任意静态文件服务器，例如：

```powershell
npx serve download
```

然后打开终端显示的本地地址。不要直接双击 HTML 文件，因为部分浏览器会限制本地文件调用 GitHub API。

## 部署

仓库已经提供 `.github/workflows/pages.yml`。推送到 `master` 分支且 `download/` 有变化时，工作流会自动部署本目录。

首次启用时，在 GitHub 仓库进入 **Settings → Pages**，将 **Source** 设置为 **GitHub Actions**。之后可以在仓库的 **Actions** 或 **Deployments** 页面查看部署结果。默认访问地址为：

```text
https://tokensapi.github.io/tokens_TokensHarness_code/
```

页面不需要服务端和构建步骤，也可以部署到 Cloudflare Pages、Vercel 或现有网站服务器。
