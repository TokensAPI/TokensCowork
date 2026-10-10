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
