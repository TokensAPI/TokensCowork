# 私有 npm Registry

该目录是服务器端 Verdaccio 的可提交部署文件。它不包含账号、Token、证书或域名配置。

在服务器拉取仓库后执行：

```sh
cd tokens_TokensHarness_code/market/ops/registry
docker compose pull
docker compose up -d
curl -fsS http://127.0.0.1:4873/-/ping
```

服务只绑定服务器本机的 `127.0.0.1:4873`。外部域名、HTTPS 和 Nginx 反向代理由运维配置，代理上游为 `http://127.0.0.1:4873`。

Verdaccio 的存储使用 Docker named volume 持久化。首次创建发布账号、生成市场只读 Token 等操作由运维按安全流程完成，不写入仓库。
