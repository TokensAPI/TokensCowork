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

## 管理后台（`/admin/`）

Vue 3 + TypeScript + Vite，外观是 Tabler。源码在 `admin-web/`，构建产物输出到 `admin/console/`（不进仓库；Docker 镜像第一段构建，见 `Dockerfile`），由服务端在 `/admin/` 提供。

```sh
cd market/server/admin-web
npm ci --ignore-scripts     # 依赖按 package-lock.json 固定，不执行安装脚本
npm run dev                 # http://127.0.0.1:5173/admin/console/ ，接口与 Tabler 等共用文件代理到本地 QA 服务
npm run typecheck           # vue-tsc
npm test                    # vitest（happy-dom）
npm run build               # 产出 ../admin/console/
```

- 开发时先另开一个终端起本地 QA 服务：`node ops/market-dev.mjs --offline`（默认 8788 端口；别的地址用 `MARKET_DEV_ORIGIN` 指定）。
- 也可以先 `npm run build`，直接在 QA 服务上打开 `/admin/`：这样走的是真实的安全头和缓存头。
- 页面地址沿用一直以来的写法（`#plugins`、`#keys`、`#session-logs/<会话>/<版本>` 等），旧书签照常打开对应页面；开发期的预览地址 `/admin/next/` 308 跳到 `/admin/`。
- Tabler、`brand.css`、logo 直接引用 `/admin/assets/` 下的文件；会话日志的回答用文档中心同一个 Markdown 渲染器（`admin/assets/market-markdown.js`）；自有样式在 `admin-web/src/styles/console.css`，不依赖 DOM 的纯函数在 `admin-web/src/lib/`（服务端测试也直接读它们）。
- 安全头不放宽（`script-src 'self'; style-src 'self'`）：产物没有内联脚本或样式，主题预设脚本是独立文件 `admin/console/theme.js`。
- 服务端：`/admin/`、`/admin/index.html` 返回 `admin/console/index.html`；`/admin/console/` 下只放行 `theme.js` 和 `assets/<名字>-<8 位哈希>.(js|css|svg)`（`market-worker.js` 的 `CONSOLE_FILES`），其余一律 404。
- 文档中心（`/docs`、`admin/docs.html` 及其脚本样式）和 `/admin/api-docs.html` 是独立页面，不属于这个工程。

## 后台静态文件的缓存与压缩

`/admin/*`（后台页面与构建产物、文档中心页面及其脚本样式、接口文档）由 `runtime/adapters.mjs` 提供：

- 文本类文件（html / css / js / json / svg / txt）按 `Accept-Encoding` 返回 brotli 或 gzip，带 `Vary: Accept-Encoding`；压缩结果按文件（大小 + 修改时间）缓存在进程内。
- 每个文件带 `ETag`，`If-None-Match` 命中返回 `304`。
- 自有文件 `Cache-Control: no-cache`（每次校验，发版后立即拿到新文件）；`admin/assets/vendor/` 下的第三方文件 `public, max-age=86400`。
- 后台带内容哈希的构建产物（`/admin/console/assets/`）`public, max-age=31536000, immutable`；后台页面 `/admin/` 与 `theme.js` 同样 `no-cache` + ETag。
- 安全头（CSP、`X-Frame-Options` 等）不变；`_headers` 与适配器保持一致（有用例核对）。

## 页面截图预览

改完后台页面，先看截图再交给别人：

```sh
node ops/market-screenshots.mjs                      # 全部页面，浅色 / 深色 / 窄屏（400 px）
node ops/market-screenshots.mjs --only keys,docs     # 只截部分页面
node ops/market-screenshots.mjs --out D:\shots       # 指定输出目录
```

- 起本地 QA 服务（`ops/market-dev.mjs --offline`：虚构数据、外网隔离、只在内存里），写入一篇带图片的示例文档，再用本机的 Edge（找不到则用 Chrome，或用 `MARKET_SCREENSHOT_BROWSER` 指定）无界面模式，经 Chrome DevTools 协议（Node 自带 WebSocket，不加依赖）以平台管理员登录后逐页截整页图。
- 页面：插件（含访问范围、资料、图标、下架弹窗）、组织（含详情）、用户、Key（含菜单、登记、授权弹窗）、插件文档、会话日志（列表、菜单、详情、全部展开、原始 JSON）、操作记录、接口文档、文档中心（管理员打开，以及用一次性登录码打开，同桌面应用）；文件名 `<页面>-<light|dark|narrow>.png`。先 `npm --prefix admin-web run build`。
- 本地 QA 服务发的就是线上的安全头：脚本记录每页的 CSP 拦截和未捕获的脚本错误，有任何一条就打印出来并以退出码 1 结束。
- 截图写到系统临时目录下的 `market-screenshots-<时间>`（结束时打印路径），不进仓库。
- 结束时关闭它启动的浏览器和本地服务（服务先经 IPC 正常退出，浏览器先经 DevTools 关闭，不行再按自己记下的进程号结束），不碰其他进程。
