# npm Registry

该目录是 `market/` 下面独立的 Verdaccio 服务部署单元。它只负责 npm API、Web UI、
账号和包存储；插件目录、组织/API Key 权限与市场代理属于 `market/server/`，桌面端
安装地址属于 `build/overlays/market/`。两个服务可以独立部署和迁移。

## 公开与私有

自有插件统一限制仓库直连；是否向最终用户公开，只在 Market 后台设置：

| 包名 | 匿名读取 | 发布 | 回源 npmjs |
| --- | --- | --- | --- |
| `@tokensapi-private/*` | 拒绝，仅 tokenscowork / market 可读 | tokenscowork | 否 |
| `@tokensapi/*`、`@tokens/*`、`dsh-tokensapi-ui`、`tokens-dsh-web-search` | 拒绝，仅 tokenscowork / market 可读 | tokenscowork | 是（迁移期） |
| 其他包（第三方依赖） | 允许 | tokenscowork | 是，并缓存 |

新插件统一使用 `@tokensapi/插件名`，不要用落入第三方兜底规则的任意包名。
不再要求按公开/私有改包名：Market 设为公开就允许经市场下载，设为受限则校验
组织或 API Key；修改市场范围不需要重新发布。已公开发布到 npm 的历史版本无法收回。
公开注册保持关闭。不要向最终用户提供内部仓库账号；普通新建账号也不能读取自有插件。

自有包保留 `proxy: npmjs`，因此迁移期间两边都能装：已经发到本 Registry 的版本用
本地的，还只在 npmjs 上的旧版本仍然能拉到，Verdaccio 会把本地元数据盖在 uplink
上。代价是同名包的上游版本也会出现在列表里；某个包完全迁移完毕后，把它那条规则
的 `proxy` 去掉，本地副本就成为唯一来源。

真正不回源的只有 `@tokensapi-private/*`：私有包名永远不会解析到 npmjs 上的同名包。

这张表只管有人直接把 npm 客户端指到本 Registry 时能读到什么。插件市场里谁能看到、
下载某个插件，由市场后台的访问范围（公开/受限）决定：市场代理始终用服务账号取包，
所以私有作用域的包也可以在后台设为公开并分发给所有人。改这里的 `access` 规则不需要
同步改市场，反之亦然。

其余包走 `npmjs` uplink 并缓存，因此客户端可以把本 Registry 作为唯一 npm 源使用，
插件的第三方依赖也能正常安装。缓存会随使用增长，需要关注磁盘。

## 发布权限与只读账号

`tokenscowork` 是内部发布账号；`market` 是只读服务账号。所有规则的写权限均限制为
`tokenscowork`，市场服务不能发布或删除包。新增发布者需要显式更新配置中的白名单，
仅创建 htpasswd 账号不再自动获得权限。

这一条不能改成 `$authenticated`，因为市场 Worker 也需要一个账号才能读私有包，而
Verdaccio 无法用 token 表达“只读”：`POST /-/npm/v1/tokens` 的 `readonly` 参数不生效，
签出来的 token 仍带 `$all`、`$authenticated` 组。只有把私有域的写权限收紧到白名单，
服务账号才真正动不了私有包。

仓库内部账号应只交给可信发布者和后端服务。若发布账号曾对外共享，需要轮换凭证；
收紧匿名访问不会使已泄露的内部账号自动失效。

`market` 账号的凭据以 `用户名:密码` 形式放在 Worker Secret
`MARKET_PRIVATE_REGISTRY_TOKEN`，配合 `MARKET_PRIVATE_REGISTRY_AUTH_SCHEME=basic`；Basic
凭据不会像 JWT 那样 60 天过期，要吊销只需用 `create-user.sh` 重置该账号密码。

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
cd TokensCowork/market/registry
docker compose pull
docker compose up -d
curl -fsS http://127.0.0.1:4873/-/ping
curl -fsS https://npm.tokensapi.ai/ | grep -F 'https://npm.tokensapi.ai/'
```

服务只绑定服务器本机的 `127.0.0.1:4873`。外部域名、HTTPS 和 Nginx 反向代理由运维配置，代理上游为 `http://127.0.0.1:4873`。
反代至少应保留原始 `Host`，并传递 `X-Forwarded-Proto`；即使反代头配置改变，
`VERDACCIO_PUBLIC_URL` 也会保证 UI 使用配置的公网地址。

Verdaccio 的存储使用 Docker named volume 持久化。创建发布账号和市场只读账号由运维按安全流程完成，密码不写入仓库。

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
匿名访问 Web UI 不显示自有插件。使用白名单内部账号登录后才能看到；普通账号仅登录
也不会获得自有插件读取权限。最终用户应使用 Market，不要使用仓库内部账号。
