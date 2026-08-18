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

如需临时使用固定下载链接，可在 `site-config.js` 的 `downloadOverrides` 中覆盖某个平台。

## 本地预览

在仓库根目录运行任意静态文件服务器，例如：

```powershell
npx serve download
```

然后打开终端显示的本地地址。不要直接双击 HTML 文件，因为部分浏览器会限制本地文件调用 GitHub API。

## 部署

仓库已经提供 `.github/workflows/pages.yml`。Pages 启用后，从 GitHub Actions 手动运行 `Deploy download page` 即可部署本目录。

首次启用时，需要由具备仓库管理权限的账号进入 **Settings → Pages**，将 **Source** 设置为 **GitHub Actions**。Pages 未启用前工作流不会自动运行。部署后可以在仓库的 **Actions** 或 **Deployments** 页面查看结果。默认访问地址为：

```text
https://tokensapi.github.io/tokens_TokensHarness_code/
```

页面不需要服务端和构建步骤，也可以部署到 Cloudflare Pages、Vercel 或现有网站服务器。
