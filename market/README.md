# TokensAPI 插件市场目录源

本目录是 DSH Community Market「标准目录源」的 Cloudflare Pages 实现，只收录 TokensCowork 产品自有插件。插件目录数据的唯一来源是 `roster.json`。产品装配会预置并默认选中该官方源，无需用户手动登记。

## 文件

```text
source.config.json   部署 origin 配置
source.json          目录源 manifest（生成产物，用户登记的就是它的 URL）
roster.json          插件目录的唯一源数据（手工维护）
v1/plugins           目录端点的静态兜底（部署时生成，不纳入 Git）
_headers             Cloudflare Pages 响应头声明（保证 Content-Type 为 JSON）
```

插件包名、展示信息、名册版本和 npm 状态只修改 `roster.json`。只有包已经发布并验证后才能把 `npm` 设为 `true`。GitHub Actions 会在部署前运行 `node scripts/generate-market-catalog.mjs`，现场生成 `v1/plugins`；本地手工部署时也必须先运行该命令。

## 为什么不能部署到 GitHub Pages

市场契约（`desktop/dsh-community-market/docs/schemas/catalog-source.schema.json`）强制端点路径**必须以 `/v1/plugins` 结尾**（不允许 `.json` 后缀），同时市场 Host 只接受 `Content-Type: application/json` 的响应。GitHub Pages 按扩展名推断 Content-Type，无扩展名文件一律按 `application/octet-stream` 返回且不支持自定义响应头，会被 Host 直接拒绝。因此需要一个支持自定义响应头的静态托管，本目录按 Cloudflare Pages 的 `_headers` 约定编写。

## 部署（Cloudflare Pages）

1. 提交市场相关变更到 `master`，`.github/workflows/market.yml` 会生成目录产物并部署到 Cloudflare Pages。
2. 本地 Direct Upload 前，运行 `node scripts/generate-market-catalog.mjs`，再上传 `market` 目录。
3. 部署 origin 由 `source.config.json` 声明；manifest 的 `transport.endpoint` 必须与 manifest URL 同源。
4. 验证：`curl -sI https://<origin>/v1/plugins` 应返回 `200` 且 `Content-Type: application/json`。

## 用户使用方式

TokensCowork 首次启动后即可在插件市场浏览该源，无需添加或选择。产品界面隐藏来源的添加和删除操作，Host 也拒绝删除官方源，避免误操作后市场失去唯一来源。

目录中带有经过验证的 npm 包信息时可直接安装；其他条目仍可查看介绍并跳转源码仓库。
