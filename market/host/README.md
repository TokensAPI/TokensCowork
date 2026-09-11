# 市场后台自托管单元

该目录把 `market/server/`（原 Cloudflare Pages Worker，代码零改动）打包成一个独立的
Docker 部署单元。它与 `market/registry/`（Verdaccio）是**两个平级、自包含的单元**：
可以同机部署，也可以分别部署在不同机器上——市场访问 Registry 只走公网地址
`MARKET_PRIVATE_REGISTRY_URL`，单元之间没有本机依赖。

| 单元 | 域名 | 本机端口 |
| --- | --- | --- |
| market/registry | npm.tokensapi.ai | 127.0.0.1:4873 |
| market/host | npm.tokensapi.ai（按路径分流） | 127.0.0.1:4880 |

两个服务共用一个域名：Nginx 只把市场自己的少数路径送到 4880，其余（包元数据、
tarball、`/-/` API、Web UI）全部照旧走 Verdaccio。域名不能更换：已发布包的元数据
里所有 tarball 地址都指向它。若以后拿到独立子域，只需改 `.env` 的
`MARKET_HOST_PUBLIC_ORIGIN`、给新域一个整站 `proxy_pass` 到 4880 的 server 块，
并重新烘焙桌面版本。

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

Nginx：在现有 `npm.tokensapi.ai` 的 server 块里、默认 `location /`（Verdaccio）
**之前**加入下面的分流规则。市场只认这些路径，根路径与 `/-/` 命名空间不受影响：

```nginx
  # ---- 插件市场（其余路径一律照旧走 Verdaccio）----
  location = /v1/plugins  { include snippets/tokenscowork-market.conf; }
  location = /v1/plugins/ { include snippets/tokenscowork-market.conf; }
  location = /roster.json { include snippets/tokenscowork-market.conf; }
  location = /source.json { include snippets/tokenscowork-market.conf; }
  location ^~ /api/admin/ { include snippets/tokenscowork-market.conf; }
  # 同名 npm 包让路：`/包名` 元数据与 `/包名/-/` tarball 仍归 Verdaccio
  location = /admin       { proxy_pass http://127.0.0.1:4873; }
  location ^~ /admin/-/   { proxy_pass http://127.0.0.1:4873; }
  location ^~ /admin/     { include snippets/tokenscowork-market.conf; }
  location = /registry    { proxy_pass http://127.0.0.1:4873; }
  location ^~ /registry/-/ { proxy_pass http://127.0.0.1:4873; }
  location ^~ /registry/  { include snippets/tokenscowork-market.conf; }
  location = /downloads   { proxy_pass http://127.0.0.1:4873; }
  location ^~ /downloads/-/ { proxy_pass http://127.0.0.1:4873; }
  location ^~ /downloads/ { include snippets/tokenscowork-market.conf; }
```

`snippets/tokenscowork-market.conf`（新建一次，供上面复用）：

```nginx
proxy_pass http://127.0.0.1:4880;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Real-IP $remote_addr;
client_max_body_size 1m;
```

遮挡说明：名为 `admin`/`registry`/`downloads` 的 npm 包，元数据和 tarball 路径已被
上面的规则让回 Verdaccio，仅 `GET /包名/版本号` 这种少见的单版本查询会落到市场返回
404；名为 `v1` 的包只有无意义的 `/v1/plugins` 被占用。正常 `npm install` 不受影响。

## 数据迁移（从 Cloudflare D1 一次性导入）

本地导出（需要 wrangler 登录）：

```bash
npx --yes wrangler@4 d1 export tokenscowork-market-access --remote --output market-d1-export.sql
```

把导出文件放到服务器本目录后导入（sqlite 文件在 named volume 里，用临时容器执行）：

```bash
docker compose stop market
docker run --rm -v tokenscowork-market-host-data:/data -v "$PWD:/import:ro" node:24-alpine \
  sh -c "rm -f /data/market.sqlite* && node -e \"const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/market.sqlite');db.exec(require('fs').readFileSync('/import/market-d1-export.sql','utf8'));db.exec('DELETE FROM market_admin_sessions; DELETE FROM market_admin_login_limits');console.log('imported')\""
docker compose up -d --build
```

导出文件自带完整建表语句，所以导入必须落在空库上（上面的 `rm` 就是干这个的——
容器首次启动会先建好带种子的库）。导入的数据里包含 `market_data_migrations` 标记，
重启后 migrations 重放不会重复种子。

导入后 D1 原库冻结保留，不删除；后台登录会话与限流桶已清空，重新登录即可。

## 备份与搬机

数据全部在 named volume `tokenscowork-market-host-data`（sqlite + 上传包）：

```bash
docker run --rm -v tokenscowork-market-host-data:/data -v "$PWD:/backup" alpine:3.20 \
  tar czf /backup/market-host-data.tgz -C /data .
```

搬机 = 新机器解包同名 volume + 复制 `.env` + `docker compose up -d --build` + 把
`npm.tokensapi.ai` 的 DNS 指到新机器（连同 Nginx 配置一起带走）。Registry 单元同理（见 `market/registry/README.md`），
两个单元互不影响，可以分开搬。

## 升级

服务器上 `git pull` 后 `docker compose up -d --build`。migrations 幂等，重启自动补齐。
