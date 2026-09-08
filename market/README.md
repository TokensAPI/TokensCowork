# TokensCowork 插件市场与管理后台

## 工程结构与边界

```text
market/
├── _worker.js                  Cloudflare 约定入口，仅转发
├── _headers                    静态响应头与页面安全策略
├── server/
│   ├── market-worker.js        请求分发、目录与 npm 版本查询
│   ├── routes/                 管理与下载 HTTP 路由
│   ├── services/               插件访问规则、组织提供方适配
│   ├── security/               会话、Key 指纹与加密存储
│   └── http/                   请求解析、校验与响应
├── admin/
│   ├── index.html              管理页面结构，URL 保持 /admin/
│   ├── access.html             旧入口兼容跳转
│   └── assets/                 market-admin.js / market-api.js / market-admin.css
├── database/migrations/        按编号执行的幂等 SQL
├── ops/                        运维脚本与检查工具，不对公网开放
├── tests/                      权限、会话、加密、目录与静态隔离测试
├── legacy/admin/               未加载的历史页面脚本，仅供迁移参考
├── roster.json                 唯一插件名册
├── source.config.json          市场源配置
└── package.json                统一维护命令
```

### 分层约定

- HTTP 路由负责鉴权、输入校验与响应；访问规则在 services，密码学操作在 security。页面不直接调用数据库或组织提供方。
- 浏览器请求统一走 `admin/assets/market-api.js`；该模块不操作 DOM。页面状态与交互在 `market-admin.js`，后续再按功能拆分，不为目录重排引入框架。
- 文件采用小写 kebab-case；前端资源和运维入口保留 `market-` 前缀。Cloudflare 强制的 `_worker.js` / `_headers` 不改名。
- 静态资源采用显式白名单，新增前端资源须同步 `server/market-worker.js`。源码、数据库、运维、测试、历史文件不公开提供。
- 桌面产品覆盖仍在父仓库 `build/overlays/market/`，不混入市场后台，不修改只读子模块。
- 现有 API、Cookie 名称、会话有效期与授权数据保持兼容。SQL 的 001/002 是现有幂等基线，不是新的数据库重建；后续变更另建递增编号脚本，禁止重置生产表。

### 常用命令（父仓库根目录）

```powershell
npm --prefix market run verify  # 语法、相对引用、测试、名册一致性
npm --prefix market test        # 后端回归
npm --prefix market run build   # 生成现有部署产物
```

部署仍使用 Cloudflare Pages 的现有项目，CI 已同步新路径。部署前按序执行 database/migrations 中的 SQL，再生成目录并上传 market。
生成产物 `source.json` 和 `v1/plugins` 不手改；不要将凭证、会话令牌或安装包加入版本库。
完整 Key 的加密密钥和授权指纹密钥必须保留，目录重构不轮换任何秘密。

本目录是 DSH Community Market「标准目录源」的 Cloudflare Pages 实现，只收录 TokensCowork 产品自有插件。插件目录数据的唯一来源是 `roster.json`。产品装配会预置并默认选中该官方源，无需用户手动登记。

## 文件

```text
source.config.json   部署 origin 配置
source.json          目录源 manifest（生成产物，用户登记的就是它的 URL）
roster.json          插件目录的唯一源数据（手工维护）
v1/plugins           目录端点的静态兜底（部署时生成，不纳入 Git）
_headers             Cloudflare Pages 响应头声明（保证 Content-Type 为 JSON）
```

插件包名、展示信息、名册版本和 npm 状态只修改 `roster.json`。只有包已经发布并验证后才能把 `npm` 设为 `true`。GitHub Actions 会在部署前运行 `node scripts/generate-market-catalog.mjs`，现场生成 `v1/plugins`；本地手工部署时也必须先运行该命令。

## 为什么不能部署到 GitHub Pages

市场契约（`desktop/dsh-community-market/docs/schemas/catalog-source.schema.json`）强制端点路径**必须以 `/v1/plugins` 结尾**（不允许 `.json` 后缀），同时市场 Host 只接受 `Content-Type: application/json` 的响应。GitHub Pages 按扩展名推断 Content-Type，无扩展名文件一律按 `application/octet-stream` 返回且不支持自定义响应头，会被 Host 直接拒绝。因此需要一个支持自定义响应头的静态托管，本目录按 Cloudflare Pages 的 `_headers` 约定编写。

## 部署（Cloudflare Pages）

1. 提交市场相关变更到 `master`，`.github/workflows/market.yml` 会生成目录产物并部署到 Cloudflare Pages。
2. 本地 Direct Upload 前，运行 `node scripts/generate-market-catalog.mjs`，再上传 `market` 目录。
3. 部署 origin 由 `source.config.json` 声明；manifest 的 `transport.endpoint` 必须与 manifest URL 同源。
4. 验证：`curl -sI https://<origin>/v1/plugins` 应返回 `200` 且 `Content-Type: application/json`。

## 用户使用方式

TokensCowork 首次启动后即可在插件市场浏览该源，无需添加或选择。产品界面隐藏来源的添加和删除操作，Host 也拒绝删除官方源，避免误操作后市场失去唯一来源。

目录中带有经过验证的 npm 包信息时可直接安装；其他条目仍可查看介绍并跳转源码仓库。
