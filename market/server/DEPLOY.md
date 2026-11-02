# 市场服务部署

市场与 Registry 是独立服务：

| 服务 | 公网域名 | 本机监听 | 持久数据 |
| --- | --- | --- | --- |
| 市场 | market.tokensapi.ai | 127.0.0.1:4880 | tokenscowork-market-host-data，SQLite 与归档缓存 |
| Registry | npm.tokensapi.ai | 127.0.0.1:4873 | Registry storage/plugins volumes |

Cloudflare Pages 旧入口已退役。旧来源需切换到
`https://market.tokensapi.ai/source.json`，不再部署旧代理或初始化 Cloudflare D1。
Worker/D1 风格接口仍由 Node/SQLite 适配器实现，它是当前业务接口，不是旧部署依赖。

## 日常更新

使用 Actions 的 **部署 · 插件市场**，选择 master；市场服务与其生成输入变更也会自动触发。
流程先执行 `yarn test:market` 和部署脚本语法检查，再通过 SSH 部署同一个测试通过的提交。
配置及安全边界见 [CI 部署说明](../deploy/README.md)。

已有服务器继续使用现有 `.env`、容器名、端口和数据卷。CI 会先创建 SQLite 一致性备份，
再替换市场镜像；失败时按部署脚本恢复原镜像，不覆盖数据库或重置授权密钥。
此入口不更新 Registry 或 Nginx，也不用于空机初始化。

## 独立域名反代

市场公网 origin 为 `https://market.tokensapi.ai`，由 `.env` 的
`MARKET_HOST_PUBLIC_ORIGIN` 固定。market.tokensapi.ai 的 HTTPS server 块整站代理到 4880：

```nginx
location / {
    proxy_pass http://127.0.0.1:4880;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 1m;
}
```

会话日志上传（`POST /v1/session-logs`）单批最多 8 MiB，需要单独放宽请求体上限，其余路径保持 1m：

```nginx
location = /v1/session-logs {
    proxy_pass http://127.0.0.1:4880;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 9m;
}
```

没加这一段之前，超过 1 MiB 的批次会被 Nginx 回 `413`，客户端会把单批减半重发，日志照样能传完，只是批数变多。

Registry 域名继续代理到 4873。TLS、DNS 和 Nginx 由运维维护，不在市场 CI 中修改。
不要再使用两个服务共用 npm 域名的旧分流规则。

插件归档（`/registry/<插件>/<包>/<版本>/tarball`）是边拉边回的流式响应：反代不要
对这个前缀设置短的 `proxy_read_timeout`，也不要关掉响应缓冲之后再限制
`proxy_max_temp_file_size`——慢网络的客户端可能要几分钟才取完一个包。

## 配置与数据

业务 Secret 只存服务器 `.env`，不得提交或输出。特别是 HMAC 和 Key 加密密钥，
更新、恢复或搬机都必须沿用已有值；更换会使已授权 Key 指纹及加密数据失效。
市场运行时无安装 npm 依赖的步骤，所有插件压缩包从独立 Registry 获取。

数据卷里的 `tarball-cache/` 是已验证归档的缓存：只保存摘要与 Registry 的 `integrity`
核对通过的完整包，同一版本的后续下载不再回源。它可以随时整目录删除（下次下载重新
回源填充），不需要备份；上限用 `MARKET_TARBALL_CACHE_MAX_BYTES` 控制，设 0 即关闭。
缓存只是存储：授权判断仍在查缓存之前，撤权后连已缓存的包也不发。

## 会话日志

客户端上传的会话日志（接口见 SERVICE-API.md「会话日志」）**不脱敏，含用户的文件内容、命令输出和密钥**。
只有平台管理员能在后台查看和下载，每次打开会话详情、每次下载原始 JSON 都写操作记录；数据卷、备份和 OSS 桶都要按敏感数据管理，
不要拷到个人电脑、不要发到工单或聊天里。

数据默认放在数据卷的独立目录 `session-logs/`，与 `market.sqlite` 互不影响：

| 路径 | 内容 |
| --- | --- |
| `session-logs/index.sqlite` | 索引：会话表、事件索引（去重唯一键）、会话用过的 Key（`MARKET_KEY_ENCRYPTION_SECRET` 加密，未配置时只有指纹）、保留期设置。不含明文 Key |
| `session-logs/objects/session-logs/<yyyy>/<mm>/<会话>/<格式版本>/<afterSeq>-<throughSeq>.json.gz` | 原文：每个被接受的批次一份 gzip |

`.env` 配置项（都可省略）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MARKET_SESSION_LOG_STORAGE` | `local` | 原文存储后端：`local`（数据卷）、`s3`（S3 兼容对象存储，如阿里云 OSS）、`off`（关闭，接口回 `503`） |
| `MARKET_SESSION_LOG_DIR` | `/data/session-logs` | 索引与本地原文的目录 |
| `MARKET_SESSION_LOG_RATE_PER_MINUTE` | `120` | 每把 Key（匿名按来源地址）每分钟可上传几批 |
| `MARKET_SESSION_LOG_S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | — | `s3` 后端用。**S3 实现目前只是桩**：配成 `s3` 服务会拒绝启动，不会悄悄退回本地磁盘 |

后台显示完整的上传 Key，前提是 `.env` 配了 `MARKET_KEY_ENCRYPTION_SECRET`（与 Key 名录共用）：没配时不保存 Key，只记指纹，
后台会提示「未配置 Key 加密，未保存原文」。配上之后，同一把 Key 只要再有一次上传被存下，之前只记了指纹的会话也能显示这把 Key
（同一指纹即同一把 Key）。换这个密钥会让已存的 Key 解不开（显示为未保存原文），同样要等这把 Key 再上传一次。

换存储后端只改配置：业务代码只依赖 `put / get / delete / list(prefix)` 四个方法（`runtime/session-log-storage.mjs`），
新后端要先通过 `tests/session-log-storage.test.mjs` 里的共用契约用例。索引始终是本地 SQLite 文件。

保留期在后台「会话日志」页设置，默认永久保留；设为 N 天后，服务每小时删除最近一次上传早于 N 天的会话（原文与索引一起删）。
也可以在后台按会话或按日期范围手动删除，都会写操作记录。

备份：`index.sqlite` 用 SQLite 一致性备份（例如 `VACUUM INTO`），原文目录直接按文件复制；先备份索引、再复制原文，
恢复时两者放回同一目录即可（多出的原文对象无害，缺少的对象在会话详情里显示为「原文缺失」）。
CI 部署只快照 `market.sqlite`，不含会话日志；替换镜像不会动这个目录。

## 备份

备份市场 SQLite 时应使用 SQLite 一致性备份方式，不能将运行中的数据库直接打包作为可靠快照。
日常部署的快照和恢复方法见 [CI 部署说明](../deploy/README.md)。
搬机分别备份市场数据卷、Registry 存储、`.env` 与反代配置；仅复制代码不够。

## 历史 D1 数据迁移

`ops/import-d1-export.mjs` 仅供一次性导入历史 D1 导出，不属于构建或部署前置。
它会替换目标 SQLite 文件，只能对已备份、已停服务且明确用于恢复的目标使用。
日常升级和 Cloudflare 旧入口退役都不运行这个工具，也不删除原 D1 历史库。
