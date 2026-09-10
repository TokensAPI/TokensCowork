# 私有 npm Registry

该目录是独立的 Verdaccio 服务部署单元。它只负责 npm API、Web UI、账号和包存储；
插件目录、组织/API Key 权限与市场代理属于 `market/server/`，桌面端安装地址属于
`build/overlays/market/`。三个目录可以独立部署和迁移。

该目录不包含账号、Token、证书或真实域名配置。首次部署时，在本目录创建未提交的
`.env`（可由 `.env.example` 复制）：

```bash
cp .env.example .env
# 按实际公网域名修改 VERDACCIO_PUBLIC_URL
```

`VERDACCIO_PUBLIC_URL` 是 Verdaccio 6 用来生成 Web UI `<base>`、静态资源和登录
跳转地址的公开基址。没有它时，反代场景可能把内部的 `127.0.0.1:4873` 写进页面，
导致用户浏览器访问自己的本机端口。

在服务器拉取仓库后执行：

```bash
cd tokens_TokensHarness_code/market/registry
docker compose pull
docker compose up -d
curl -fsS http://127.0.0.1:4873/-/ping
curl -fsS https://npm.tokensapi.ai/ | grep -F 'https://npm.tokensapi.ai/'
```

服务只绑定服务器本机的 `127.0.0.1:4873`。外部域名、HTTPS 和 Nginx 反向代理由运维配置，代理上游为 `http://127.0.0.1:4873`。
反代至少应保留原始 `Host`，并传递 `X-Forwarded-Proto`；即使反代头配置改变，
`VERDACCIO_PUBLIC_URL` 也会保证 UI 使用配置的公网地址。

Verdaccio 的存储使用 Docker named volume 持久化。首次创建发布账号、生成市场只读 Token 等操作由运维按安全流程完成，不写入仓库。
