# TokensCowork 插件市场

## 日常管理：不再修改代码

入口为 `/admin/`。可选插件的资料、版本策略、上架状态、组织和单独 Key 授权均保存在 D1 数据库，由后台维护。

1. **新建插件**：填写 ID 与包名，可从 npm 读取指定版本或 latest 的元数据，核对名称、简介和 GitHub 仓库，保存为草稿。也支持固定 40 位 Git commit 的安装源。
2. **配置权限**：组织和单独 Key 任一命中即可访问；两项留空表示上架后公开。草稿无论配置何种权限都不会在客户端出现。
3. **首次上架**：按组织/Key 配置访问范围，公开上架需单独确认。npm 插件上架时核对当前 latest 为稳定版，登记版本已过时也不必先手工更新。完整生产依赖许可证检查是发布前的独立责任，本后台不会自行扫描，也不会把 npm 的 license 字段视为检查结果。
4. **编辑与更新**：npm 新版本只需发布到 npm latest，市场自动发现，不需再次保存或上架。名称、简介和权限不自动覆盖；管理员主动更换包名、仓库、安装源或登记版本时仍会退回草稿。
5. **下架与回收站**：已上架插件先下架，再移入回收站。资料与授权保留，恢复后是草稿，不会自动公开。回收站支持「彻底删除」，须输入完整插件 ID 确认；原子删除市场资料及关联组织/Key 授权，保留受保留期限制的操作日志和共享组织/Key 身份。不删除 npm 包、私有存储文件或客户端已安装插件。彻底删除无法从后台恢复，此 ID 可重新创建为无旧授权的草稿。

npm 插件统一自动跟随稳定版 latest（包括历史标记为 pinned 的 npm 记录）；固定 Git commit 插件不变。`/v1/plugins`、兼容 `/roster.json` 和后台版本显示使用同一解析逻辑，最多 6 个并发查询，并复用最长约 120 秒的 registry 边缘缓存；在访问/刷新目录时发现版本，不是后台定时改数据库。npm 无响应或 latest 是预发布版时暂不向应用提供该 npm 条目，不把旧版本伪装成可安装的 latest。草稿、下架和回收站不会自动上架。

数据库保留登记版本，后台卡片另显示当前 npm 版本。自动发现不会写数据库、改修订号、权限或审核记录；更新展示不等于静默升级用户已安装的插件。各插件的 npm 发布前许可证检查流水线不在本市场内，尚需由对应发布仓库保证。

下架阻止新的市场展示和私有下载，不会卸载用户已安装的插件。客户端已有索引可能需要刷新/等待缓存过期。公开 npm/GitHub 包仍能从原地址下载，本市场权限不等于包内容的私有分发。

## 数据来源与边界

「授权验证」先通过 TokensAPI 当前组织接口验证 Key：成功响应（包括个人 Key 的 organization=null）才继续计算所见范围；401/403 直接停止，服务超时或异常提示重试，不把“无法验证”误报成“Key 无效”。此修改仅作用于后台诊断入口，不改变市场原有授权规则，不记录提交的 Key。

- `market_plugins`：可选插件规范元数据、访问范围和私有对象引用。
- `market_catalog`：草稿/已上架/已下架/回收站状态、修订号、版本策略、检查记录。
- 原组织、Key 指纹、加密 Key 和授权表继续使用，迁移不会轮换密钥或重建授权。
- 内置组件不作为市场商品展示。由 `product.json` 在构建时自动生成 `product-components.json`，仅用于防止误登记应用内置 ID/包名；该文件不是公开的插件名册，也不代表每位用户实际安装的桌面版本。
- 已移除手工 `roster.json` 和静态插件快照。`/roster.json` 仅作为旧客户端兼容 HTTP 路径保留，返回经过权限过滤的数据库目录，不读同名文件。
- 数据库不可用时目录返回 503，不会用旧静态内容复活已下架插件。

## 工程结构

```text
market/
├── server/routes/                  HTTP 鉴权、请求校验与路由
├── server/services/catalog-service.js  插件生命周期与乐观并发控制
├── server/services/plugin-access-service.js  统一授权规则
├── server/integrations/             npm / TokensAPI 服务适配
├── server/registry/                 可选私有 npm Registry 代理（仅服务端）
├── server/security/                 会话、限流、Key 加密与指纹
├── admin/assets/market-admin.js     工作台与权限编辑交互
├── admin/assets/market-catalog-editor.js  插件资料与状态表单
├── admin/assets/market-model.js     可测试的筛选与 Key 去重
├── admin/assets/market-api.js       有超时、无写入自动重试的请求层
├── database/migrations/             递增编号的幂等迁移
├── ops/                            本地演示、配置、检查脚本
└── tests/                          权限、生命周期、迁移与异常回归
```

管理数据只在登录后展示，会话保持 7 天。完整 Key 加密存储，仅授权管理端可读。密码错误有来源限流；同源校验防止跨站写入。插件编辑、上架及权限保存共享修订号；旧页面覆盖新更改时返回 409。操作记录与变更同事务保存，最新 50 条可见、服务端最多保留 1000 条，不记录 Key 明文。

TokensAPI 接口及环境配置见 [TOKENSAPI.md](TOKENSAPI.md)。不同环境可能复用组织 ID，生产/测试应使用独立数据库；切换 URL 前须核对组织关系。

## 开发与测试

新建插件时可在「npm 包名或链接」粘贴 npmjs.com 的包详情页地址，点击「读取并自动填写」；支持普通包、作用域包以及 `/v/版本` 链接。读取后自动填写包名、建议 ID、版本和公开简介，管理员可以修改再保存。已有插件 ID 或手工填写的 ID 不会被覆盖。

npm 安装的 GitHub 仓库为选填，固定 Git commit 安装仍必须填写。预发布版本（例如 `0.1.0-beta.1`）可保存草稿，但当前桌面安装器只支持稳定版，因此预发布版本暂不可上架。npm 的许可证字段仅供提示，不代表完整依赖检查通过；导入不会自动创建、授权或上架插件。

简介默认使用包版本的 `description`；导入时另外读取 npm 当前 README 的开头介绍，作为纯文本候选展示，点击「采用这段简介」后才填入表单。当前 README 可能与历史包版本不同，须人工核对。README 请求失败或内容过大时仍允许使用包描述、手工填写，不影响导入；不会执行或渲染 README 中的脚本/HTML。

```powershell
npm --prefix market run build
npm --prefix market run verify
npm --prefix market run dev:check
npm --prefix market run dev
```

本地演示仅监听 `127.0.0.1:8788`，使用虚构组织和内存数据库，重启重置；外网阻断，不读取生产部署配置。可在仓库根目录 `.market-dev.env` 设置 `MARKET_DEV_ADMIN_TOKEN`（已被 Git 忽略，不在网页目录内），或使用同名环境变量；未配置时使用演示凭证 `market-test`。自定义凭证不会打印到日志。不要输入真实 Key。

## 一次性迁移与部署

部署仍使用现有 Cloudflare Pages 项目。执行顺序：数据库迁移 → 生成部署文件 → 部署 Worker/管理页面。CI 按文件名顺序执行 SQL。

`004-database-catalog.sql` 是历史目录的一次性快照：迁移既有四个可选插件、保留所有旧授权，排除内置组件。迁移标记确保重跑不会覆盖后台编辑，也不会恢复回收站中的插件。**后续新增插件不能再改此迁移文件。**

首次上线前应备份 D1，并核对既有插件和授权数量。应用 004 后继续使用旧 Worker 会忽略生命周期状态，因此开始后台管理后不能简单回滚到旧静态目录版本；修复应前向发布，或在维护窗口配合数据库备份恢复。

`npm run build` 仅生成 `source.json` 与产品组件身份清单，不生成插件目录。新增可选插件无须更新桌面安装包。源码、数据库脚本、组件身份文件和运维工具不在 Worker 公共静态资源白名单内。所有真实凭证只在服务端秘密配置中保存。

## 可选私有 npm Registry

公开 npm 插件无需任何额外配置。需要受控分发的包可在后台把「npm 来源」选为「TokensCowork 私有 Registry」；市场会在上架和每次目录刷新时读取私有 Registry 的稳定 `latest`，并通过 `/registry/` 代理元数据和 tarball。代理先检查市场的组织/Key 权限，再使用服务端 Secret 访问上游 Registry；桌面端只会拿到当前用户自己的 API Key，不会拿到 Registry Token。

服务器还未准备好时保持 `MARKET_PRIVATE_REGISTRY_ENABLED` 未设置（或不是 `true`），私有来源不会显示为可安装条目，公开 npm 完全不受影响。服务器准备好后只需配置以下 Worker Secret/变量并重新部署市场，不需要修改插件目录代码，也不需要为了每次 npm 发版重打桌面包：

```text
MARKET_PRIVATE_REGISTRY_ENABLED=true
MARKET_PRIVATE_REGISTRY_URL=https://你的-registry.example/npm/
MARKET_PRIVATE_REGISTRY_TOKEN=<只放在 Worker Secret 中>
```

Registry 必须是 HTTPS、无用户名密码/query/fragment 的标准 npm Registry；市场会拒绝重定向、无效包元数据和超过大小上限的响应。私有包仍需先在后台登记、配置组织或单独 Key 权限并上架。没有权限、上游不可用或配置缺失时均 fail-closed，不会静默回退到公开 npm。
