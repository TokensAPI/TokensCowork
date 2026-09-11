# 旧入口薄代理

`tokenscowork-market.pages.dev` 烘焙在 0.4.12 之前所有桌面安装包里，永远不能下线。
后台迁到自建服务（`market/server/`，与 Registry 共用 npm.tokensapi.ai，按路径分流）之后，这个 Pages 项目改为部署
本目录：除 `/source.json`（必须保持 pages.dev endpoint 的旧 manifest，桌面同源信任
要求）外，其余请求全部透传到自建服务，数据只有服务器一份。

`source.json` 是为 pages.dev 这个域生成的最后一版 manifest 快照；`market/server/`
里的同名文件之后会指向新域名，两者各归各的域，不要互相覆盖。

切换与回滚都只改 `.github/workflows/market.yml` 的部署目录（`market/legacy` ⇄
`market/server`）。回滚回直连模式时，Cloudflare D1 里是切换时刻的冻结数据。
