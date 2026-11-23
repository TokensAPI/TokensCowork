# 市场管理服务

本目录包含后台页面、业务接口、数据库迁移与 Docker 部署入口。
`runtime/` 提供 Node HTTP 和 SQLite 适配；`ops/` 存放管理脚本。

服务器目录：`/home/wsy/TokensCowork/market/server`。

```sh
docker compose up -d --build
curl -fsS http://127.0.0.1:4880/v1/plugins
```

独立域名由运维配置：`market.tokensapi.ai` 转发到 `127.0.0.1:4880`。
启用新域名前将服务器 `.env` 的 `MARKET_HOST_PUBLIC_ORIGIN` 更新为
`https://market.tokensapi.ai` 并重建容器。npm 仓库保持 `npm.tokensapi.ai:443`，
内部端口 4873。旧 Cloudflare Pages 入口已退役，客户端来源使用
`https://market.tokensapi.ai/source.json`。

数据卷继续使用 `tokenscowork-market-host-data`，容器名和环境变量保留兼容命名。
凭证 `.env` 和数据库导出不得提交。部署、备份及迁移边界见 DEPLOY.md。

## 新后台（`/admin/next/`）

后台正在从 `/admin/`（原生 JS）一页一页迁到 Vue 3 + TypeScript + Vite，外观仍是 Tabler，迁移期间两套并存、登录通用。
源码在 `admin-web/`，构建产物输出到 `admin/next/`（不进仓库；Docker 镜像第一段构建，见 `Dockerfile`）。

```sh
cd market/server/admin-web
npm ci --ignore-scripts     # 依赖按 package-lock.json 固定，不执行安装脚本
npm run dev                 # http://127.0.0.1:5173/admin/next/ ，接口与 Tabler 等共用文件代理到本地 QA 服务
npm run typecheck           # vue-tsc
npm test                    # vitest（happy-dom）
npm run build               # 产出 ../admin/next/
```

- 开发时先另开一个终端起本地 QA 服务：`node ops/market-dev.mjs --offline`（默认 8788 端口；别的地址用 `MARKET_DEV_ORIGIN` 指定）。
- 也可以先 `npm run build`，直接在 QA 服务上打开 `/admin/next/`：这样走的是真实的安全头和缓存头。
- 地址与旧后台同形（`#keys`），`/admin/next/#keys` 与 `/admin/#keys` 是同一页；尚未迁移的页面在侧栏里直接链到旧后台。
- Tabler、`brand.css`、logo 直接引用 `/admin/assets/` 下的同一份文件，不打包第二份；自有样式在 `admin-web/src/styles/console.css`。
- 安全头不放宽（`script-src 'self'; style-src 'self'`）：产物没有内联脚本或样式，主题预设脚本是独立文件 `admin/next/theme.js`。
- 服务端只放行 `/admin/next/`、`index.html`、`theme.js` 和 `assets/<名字>-<8 位哈希>.(js|css|svg)`（`market-worker.js` 的 `NEXT_CONSOLE`），其余一律 404；`/admin/next` 308 到 `/admin/next/`。

## 后台静态文件的缓存与压缩

`/admin/*`（后台页面、脚本、样式和文档中心页面）由 `runtime/adapters.mjs` 提供：

- 文本类文件（html / css / js / json / svg / txt）按 `Accept-Encoding` 返回 brotli 或 gzip，带 `Vary: Accept-Encoding`；压缩结果按文件（大小 + 修改时间）缓存在进程内。
- 每个文件带 `ETag`，`If-None-Match` 命中返回 `304`。
- 自有文件 `Cache-Control: no-cache`（每次校验，发版后立即拿到新文件）；`admin/assets/vendor/` 下的第三方文件 `public, max-age=86400`。
- 新后台带内容哈希的产物（`/admin/next/assets/`）`public, max-age=31536000, immutable`；它的 `index.html` 与 `theme.js` 同样 `no-cache` + ETag。
- 安全头（CSP、`X-Frame-Options` 等）不变；`_headers` 与适配器保持一致（有用例核对）。

## 页面截图预览

改完后台页面，先看截图再交给别人：

```sh
node ops/market-screenshots.mjs                      # 全部页面，浅色 / 深色 / 窄屏（400 px）
node ops/market-screenshots.mjs --only keys,docs     # 只截部分页面
node ops/market-screenshots.mjs --only keys,next-keys,keys-menu,next-keys-menu   # 新旧 Key 页对比（需先构建新后台）
node ops/market-screenshots.mjs --out D:\shots       # 指定输出目录
```

- 起本地 QA 服务（`ops/market-dev.mjs --offline`：虚构数据、外网隔离、只在内存里），写入一篇带图片的示例文档，再用本机的 Edge（找不到则用 Chrome，或用 `MARKET_SCREENSHOT_BROWSER` 指定）无界面模式，经 Chrome DevTools 协议（Node 自带 WebSocket，不加依赖）以平台管理员登录后逐页截整页图。
- 页面：插件、组织、Key、用户、插件文档、会话日志列表、会话日志详情、文档中心；文件名 `<页面>-<light|dark|narrow>.png`。
- 新后台的页面以 `next-` 开头，与旧页同名对照（`keys` / `next-keys`）；`-menu`、`-dialog`、`-grants` 是打开「更多」菜单、登记弹窗、授权弹窗后的样子；`next-legacy` 是尚未迁移页面的提示页。截新后台前先 `npm run build`。
- 本地 QA 服务发的就是线上的安全头：脚本记录每页的 CSP 拦截和未捕获的脚本错误，有任何一条就打印出来并以退出码 1 结束。
- 截图写到系统临时目录下的 `market-screenshots-<时间>`（结束时打印路径），不进仓库。
- 结束时关闭它启动的浏览器和本地服务（服务先经 IPC 正常退出，浏览器先经 DevTools 关闭，不行再按自己记下的进程号结束），不碰其他进程。
