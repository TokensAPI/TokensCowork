# 市场服务部署

市场与 Registry 是独立服务：

| 服务 | 公网域名 | 本机监听 | 持久数据 |
| --- | --- | --- | --- |
| 市场 | market.tokensapi.ai | 127.0.0.1:4880 | tokenscowork-market-host-data，SQLite |
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

Registry 域名继续代理到 4873。TLS、DNS 和 Nginx 由运维维护，不在市场 CI 中修改。
不要再使用两个服务共用 npm 域名的旧分流规则。

## 配置与数据

业务 Secret 只存服务器 `.env`，不得提交或输出。特别是 HMAC 和 Key 加密密钥，
更新、恢复或搬机都必须沿用已有值；更换会使已授权 Key 指纹及加密数据失效。
市场运行时无安装 npm 依赖的步骤，所有插件压缩包从独立 Registry 获取。

备份市场 SQLite 时应使用 SQLite 一致性备份方式，不能将运行中的数据库直接打包作为可靠快照。
日常部署的快照和恢复方法见 [CI 部署说明](../deploy/README.md)。
搬机分别备份市场数据卷、Registry 存储、`.env` 与反代配置；仅复制代码不够。

## 历史 D1 数据迁移

`ops/import-d1-export.mjs` 仅供一次性导入历史 D1 导出，不属于构建或部署前置。
它会替换目标 SQLite 文件，只能对已备份、已停服务且明确用于恢复的目标使用。
日常升级和 Cloudflare 旧入口退役都不运行这个工具，也不删除原 D1 历史库。
