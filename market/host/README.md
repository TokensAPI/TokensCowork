# 市场后台自托管单元

该目录把 `market/server/`（原 Cloudflare Pages Worker，代码零改动）打包成一个独立的
Docker 部署单元。它与 `market/registry/`（Verdaccio）是**两个平级、自包含的单元**：
可以同机部署，也可以分别部署在不同机器上——市场访问 Registry 只走公网地址
`MARKET_PRIVATE_REGISTRY_URL`，单元之间没有本机依赖。

| 单元 | 域名 | 本机端口 |
| --- | --- | --- |
| market/registry | npm.tokensapi.ai | 127.0.0.1:4873 |
| market/host | market.tokensapi.ai | 127.0.0.1:4880 |

Registry 的域名不能更换：已发布包的元数据里所有 tarball 地址都指向它。

旧入口 `tokenscowork-market.pages.dev` 烘焙在所有已发货的桌面安装包里，**永远不能
下线**；迁移完成后它变成一层薄代理（`market/edge/`）转发到本服务，数据只有这里一份。

## 组成

- `server.mjs`：node:http → Worker `fetch(request, env)` 翻译层。公网 origin 由
  `MARKET_HOST_PUBLIC_ORIGIN` 固定，不从请求头推导；陌生 `Host` 一律 403（防 DNS
  rebinding）；登录限流的客户端标识只信任 `X-Edge-Client-IP`（边缘代理）或
  `X-Real-IP`（Nginx），并删除客户端自带的 `cf-connecting-ip`。
- `adapters.mjs`：三个 Cloudflare 绑定的落盘替身——D1→`/data/market.sqlite`
  （node:sqlite，batch 走事务；启动时重放 `database/migrations/*.sql`，全部幂等）、
  R2→`/data/packages/` 目录、静态资产→镜像内的 `market/server/` 副本（含 `_headers`
  中 `/admin/*` 的安全响应头）。
- 运行时零 npm 依赖，镜像没有安装步骤。

## 部署

```bash
cd tokens_TokensHarness_code/market/host
cp .env.example .env    # 填入六个 Secret；值不入库
docker compose up -d --build
curl -fsS http://127.0.0.1:4880/v1/plugins | head -c 200
```

`.env` 必填：`MARKET_HOST_PUBLIC_ORIGIN`、`MARKET_ADMIN_TOKEN`、`MARKET_HMAC_SECRET`、
`MARKET_KEY_ENCRYPTION_SECRET`。**HMAC 与 Key 加密两个 Secret 必须沿用 Cloudflare 上的
原值**：换新会让所有已授权 API Key 的指纹与已保存的加密 Key 值全部作废。

Nginx（同机与 Registry 并存时是两个 server 块，分机时各自一块）：

```nginx
server {
  server_name market.tokensapi.ai;
  listen 443 ssl http2;
  # ssl_certificate ...; ssl_certificate_key ...;
  client_max_body_size 1m;
  location / {
    proxy_pass http://127.0.0.1:4880;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

## 数据迁移（从 Cloudflare D1 一次性导入）

本地导出（需要 wrangler 登录）：

```bash
npx --yes wrangler@4 d1 export tokenscowork-market-access --remote --output market-d1-export.sql
```

把导出文件放到服务器本目录后导入（sqlite 文件在 named volume 里，用临时容器执行）：

```bash
docker compose stop market
docker run --rm -v tokenscowork-market-host-data:/data -v "$PWD:/import:ro" node:24-alpine \
  node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/market.sqlite');db.exec(require('fs').readFileSync('/import/market-d1-export.sql','utf8'));db.exec('DELETE FROM market_admin_sessions; DELETE FROM market_admin_login_limits');console.log('imported')"
docker compose up -d --build
```

导入后 D1 原库冻结保留，不删除；后台登录会话与限流桶已清空，重新登录即可。

## 备份与搬机

数据全部在 named volume `tokenscowork-market-host-data`（sqlite + 上传包）：

```bash
docker run --rm -v tokenscowork-market-host-data:/data -v "$PWD:/backup" alpine:3.20 \
  tar czf /backup/market-host-data.tgz -C /data .
```

搬机 = 新机器解包同名 volume + 复制 `.env` + `docker compose up -d --build` + 把
`market.tokensapi.ai` 的 DNS 指到新机器。Registry 单元同理（见 `market/registry/README.md`），
两个单元互不影响，可以分开搬。

## 升级

服务器上 `git pull` 后 `docker compose up -d --build`。migrations 幂等，重启自动补齐。
