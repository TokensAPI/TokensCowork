# TokensAPI 插件市场目录源

本目录是 DSH Community Market「标准目录源」的静态实现，只收录 TokensHarness 产品自有插件（数据来自 `product.json`）。用户在客户端 **设置 → 插件 → 插件市场 → 源** 中登记 manifest URL 后，即可浏览 TokensAPI 生态的插件。

## 文件

```text
source.config.json   部署 origin 配置（唯一手工维护的文件）
source.json          目录源 manifest（生成产物，用户登记的就是它的 URL）
v1/plugins           目录端点响应（生成产物，市场 Host 拉取的插件列表）
_headers             Cloudflare Pages 响应头声明（保证 Content-Type 为 JSON）
```

`source.json` 与 `v1/plugins` 由 `node scripts/generate-market-catalog.mjs` 从 `product.json` 生成，不要手工编辑；插件的展示名与介绍改 `product.json` 后重新生成。

## 为什么不能部署到 GitHub Pages

市场契约（`desktop/dsh-community-market/docs/schemas/catalog-source.schema.json`）强制端点路径**必须以 `/v1/plugins` 结尾**（不允许 `.json` 后缀），同时市场 Host 只接受 `Content-Type: application/json` 的响应。GitHub Pages 按扩展名推断 Content-Type，无扩展名文件一律按 `application/octet-stream` 返回且不支持自定义响应头，会被 Host 直接拒绝。因此需要一个支持自定义响应头的静态托管，本目录按 Cloudflare Pages 的 `_headers` 约定编写。

## 部署（Cloudflare Pages）

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → 连接本仓库（或用 Direct Upload 只传本目录）。
2. 构建配置：无构建命令，输出目录填 `market`。
3. 部署完成后得到正式域名（如 `https://<project>.pages.dev`），把它写进 `source.config.json` 的 `origin`，重新运行生成脚本并提交——manifest 的 `transport.endpoint` 必须与 manifest URL 同源，这是市场 Host 的强制校验。
4. 验证：`curl -sI https://<origin>/v1/plugins` 应返回 `200` 且 `Content-Type: application/json`。

## 用户使用方式

在 TokensHarness 中打开 **设置 → 插件 → 插件市场 → Sources → 添加源**，填入：

```text
https://<origin>/source.json
```

添加并选中后，Discover 页即显示本产品全部插件卡片（含 GitHub 仓库链接）。当前插件未发布到 npm，卡片为 browse-only：用户可查看介绍并跳转仓库主页；如需通过市场一键安装，插件需先以精确稳定版本发布到 npm 并在生成脚本中补充 `package` 与 `latestVersion` 字段。
