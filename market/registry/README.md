# npm Registry

该目录是 `market/` 下面独立的 Verdaccio 服务部署单元。它只负责 npm API、Web UI、
账号和包存储；插件目录、组织/API Key 权限与市场代理属于 `market/server/`，桌面端
安装地址属于 `build/overlays/market/`。两个服务可以独立部署和迁移。

## 公开与私有

同一个 Registry 同时提供公开包和私有包，按包名划分：

| 包名 | 匿名读取 | 发布 | 回源 npmjs |
| --- | --- | --- | --- |
| `@tokensapi-private/*` | 拒绝，必须登录 | 需账号 | 否 |
| `@tokensapi/*`、`@tokens/*`、`dsh-tokensapi-ui`、`tokens-dsh-web-search` | 允许 | 需账号 | 否 |
| 其余任意包 | 允许 | 需账号 | 是，并缓存 |

自有包不配 `proxy`，本地副本即唯一来源，不会和 npmjs 上的同名包合并元数据；把现有
npm 包迁移进来时，直接向本 Registry `npm publish` 即可，不需要先在 npmjs 下架。
新增自有包若使用新的作用域或非作用域名字，需要在 `config.yaml` 的 `packages` 中
补一条同样不带 `proxy` 的规则，否则它会被 `**` 规则当作 npmjs 的包回源。

其余包走 `npmjs` uplink 并缓存，因此客户端可以把本 Registry 作为唯一 npm 源使用，
插件的第三方依赖也能正常安装。缓存会随使用增长，需要关注磁盘。

## security 段不能删

Web UI 登录后拿到的是 JWT。Verdaccio 在没有显式 `security.api.jwt` 时按 legacy AES
方式解析 API token，会把这个 JWT 当作无效凭证并降级为匿名请求，日志表现为
`user: null`。此时所有 `$authenticated` 的包在 Web UI 中既不出现在列表里，详情页也
返回 401，看起来像“尚无软件包”。只要还有任何包需要登录访问，就必须保留 `security`
段。修改该段会使已签发的 token 失效，所有人需要重新 `npm login`。

## 部署

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

## 账号

`auth.htpasswd.max_users: -1` 关闭了自助注册。已有账号仍可正常 `npm login`：npm 会
在请求中带上账号密码，Verdaccio 走认证分支签发 token，不经过注册接口。因此看到
`user registration disabled` 时，真正的原因通常是认证本身失败（密码哈希错误或
`htpasswd` 文件权限不对），不要靠打开 `max_users` 绕过。

需要增加账号时，不要修改 `max_users`。运维直接执行：

```bash
chmod +x scripts/create-user.sh
./scripts/create-user.sh publisher-name
```

脚本在临时容器中生成 bcrypt 哈希并写入持久化的 `htpasswd`，然后重启 Registry。
密码不会写入仓库，也不会出现在命令行参数中；注册开关始终保持关闭。

`htpasswd` 必须属于容器内的 verdaccio 用户（uid 10001、gid 65533、权限 600），否则
Verdaccio 无法写回用户文件，登录会挂起并在日志中出现 `EACCES`。

## 使用

```bash
npm login --registry=https://npm.tokensapi.ai/ --auth-type=legacy
npm publish --registry=https://npm.tokensapi.ai/
```

`--auth-type=legacy` 让 npm 使用 Verdaccio 支持的账号密码登录，不走网页登录流程。

Web UI 只是 Verdaccio 的包仓库门户，不是插件市场后台；市场服务和桌面端不依赖它。
匿名访问 Web UI 只能看到公开包，登录后才会出现私有作用域的包。
