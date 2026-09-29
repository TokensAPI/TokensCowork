# TokensCowork 插件市场

> 自建 npm 仓库存放插件包，市场后台管理上架和权限，桌面应用负责下载安装。
> 普通可选插件首次在后台登记，后续发布新版由市场发现，不需要每次修改桌面代码或重新打包。

面向插件开发者、市场管理员、运维和项目负责人。最后核对：2026-09-29（仓库实现与配置核对，不代表完整客户端生产验收）。
已知问题见[验收状态](#验收状态)，不要把架构说明当作全部功能已经验收通过。

## 服务入口与职责

| 部分 | 入口 | 职责 |
| --- | --- | --- |
| 包仓库（Verdaccio） | <https://npm.tokensapi.ai/> | 内部人员发布插件，存储包和版本 |
| 市场管理后台 | <https://market.tokensapi.ai/admin/> | 插件资料、上下架、组织与单独 API Key 授权 |
| 管理 API | <https://market.tokensapi.ai/api/v1/> | 后台页面与 TokensAPI 后端共用的同一套接口，文档见 `/admin/api-docs.html` |
| 桌面插件市场 | TokensCowork 应用内 | 展示可见插件，安装、更新和卸载 |
| 旧市场域名 | <https://tokenscowork-market.pages.dev/> | 兼容代理，不是第二套独立市场数据库 |

**发布包不等于上架；市场公开不等于仓库匿名直连；发现新版不等于用户已经升级。**

## 开发者：首次发布流程

### 1. 开发和检查

新插件统一使用 `@tokensapi/插件名`。不要随意使用其他包名：当前仓库的第三方依赖兜底规则允许公开读取，不能把自有受限插件放进该规则。

插件需要符合 DSH bundle 规范，包含编译产物、运行资源和补丁文件。发布字段示例：

```json
{
  "name": "@tokensapi/example-plugin",
  "version": "1.0.0",
  "description": "说明插件解决什么问题",
  "main": "lib/index.js",
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "publishConfig": {
    "registry": "https://npm.tokensapi.ai/"
  }
}
```

这不是完整可运行插件。`main`、`files` 和补丁路径必须匹配实际项目，必要资源也要加入打包范围。
实现方式见[插件开发指南](../docs/plugin-guide.md)。

发布前检查：

- 功能、目标桌面版本兼容性，以及停用/卸载时的资源清理。
- 用 `npm pack --dry-run` 检查文件清单，并使用实际打出的包测试，不能只运行源码。
- 不包含密钥、密码、内部配置或用户数据。
- 完整生产依赖许可证合规。后台不会自动扫描依赖许可证，npm 的 `license` 字段不是合规证明。

### 2. 发布到自建仓库

在插件自身项目目录执行：

```bash
npm login --registry=https://npm.tokensapi.ai/ --auth-type=legacy
npm whoami --registry=https://npm.tokensapi.ai/
npm publish --registry=https://npm.tokensapi.ai/
```

- `--auth-type=legacy` 使用 Verdaccio 支持的账号密码登录方式。
- 使用获准的内部发布账号。当前配置仅允许 `tokenscowork` 发布/删除包；创建账号不自动获得发布权限。
- 自助注册关闭，账号和发布白名单由内部管理员/运维管理，见 [Registry 说明](registry/README.md)。
- 内部仓库账号不交给最终用户；凭证不提交 Git。
- 私有插件不要再发布到公开 npm。`publishConfig.registry` 用于避免误选发布源。
- 市场安装目标要求稳定版本，例如 `1.0.0`。beta 可以保存在仓库或草稿中，但不要让市场使用的 `latest` 指向预发布版本。

### 3. 后台登记和上架

包发布成功后，由管理员：

1. 新建插件，填写稳定、唯一的市场 ID 和 npm 包名。
2. 新的仅自建插件选择「TokensCowork 自建 Registry」来源。
3. 读取并核对名称、简介、版本和仓库等资料，保存为草稿。
4. 在「访问」对话框里配置公开/受限和授权的组织、Key，完成发布前检查，再上架；公开上架需明确确认。

包名用于取包，市场 ID 用于市场记录和授权，不是同一个字段。
上传包不会自动创建市场条目；草稿不会出现在用户目录中。

普通 npm 来源支持用 npmjs.com 包详情链接辅助导入；自建插件应填写准确包名并选对来源，公开 npm 页面不是自建发布地址。
导入只是填写候选资料，不会自动保存、授权或上架。
简介默认取版本的 `description`；README 开头介绍作为人工选择的候选，不直接覆盖已确认内容。

**首次登记通过后台完成，不需要修改 roster.json、提交产品代码或重新部署市场。**

## 管理员：公开、受限和凭证

| 市场范围 | 最终用户访问条件 |
| --- | --- |
| 公开 | 上架后可通过市场访问，不要求命中特定组织或 Key |
| 受限：组织 | 用户 Key 对应的组织命中该插件授权，且该组织没有把它关掉 |
| 受限：单独 Key | 该 Key 命中该插件授权 |
| 受限：用户 | Key 的所属用户命中该插件授权（对该用户名下所有 Key 生效） |
| 受限：多种授权并存 | 任意一个命中即可，不要求同时满足 |

授权可以在插件的「访问范围」里配，也可以在组织、Key、用户各自的「授权插件」里配，写的是同一份数据。
访问范围（公开 / 受限）是后台里独立的开关：授权或撤销组织、Key、用户都不会改变它。
清空全部授权只是清空授权——受限插件会变成谁也看不到，而不是自动公开；要公开请显式切换范围。
组织信息由市场服务对接 TokensAPI；获取全部组织的管理 Token 只保存在服务端。
不同 TokensAPI 环境可能复用组织 ID，切换环境不能只改 URL 而不核对数据和授权。

TokensAPI 组织即租户。上表由平台决定「插件提供给哪些组织」；组织管理员登录后只有「我的组织」一页，
能关掉本组织不想要的插件，这一层**只能收窄、不能放宽**平台授权，缺省即开启，也不影响应用内置组件。
组织管理员**用自己的 TokensAPI 账号登录后台**：在 TokensAPI「个人设置 → 系统访问令牌」生成访问
令牌，连同同一页上的用户 ID 填进登录框即可，市场从不经手密码。谁算组织管理员由 TokensAPI 的组织
角色决定（Admin/Owner），市场不维护指派表；普通成员、没有组织的账号**不能登录后台**，要看自己能装
什么直接用桌面端。后台口令是另一种独立凭证，在同一张登录卡片上切换，与 TokensAPI 账号互不相通，
详见 [TokensAPI 集成](server/TOKENSAPI.md)。

后台五页：**插件**（资料、访问配置、上下架）、**组织**（同步、启停、每个组织能用的插件和开关）、
**用户**（单独授权用的 TokensAPI 用户）、**Key**（单独授权用的 Key 名录，直接显示原文）、**操作记录**。
组织、用户、Key 三种授权互相独立：单独授给某个 Key 的插件只对这个 Key 生效，组织停用、组织开关、用户授权都影响不到它。

三种凭证不能混用：

| 凭证 | 使用者 | 用途 |
| --- | --- | --- |
| Registry 发布账号 | 内部发布人员 | 上传/删除仓库包 |
| 市场后台口令 | 平台管理员、TokensAPI 后端 | 编辑目录和授权（后台登录或 `/api/v1` Bearer） |
| 用户 TokensAPI API Key | 最终用户 | 计算市场访问范围 |

管理数据在登录后展示，管理会话保持 7 天。完整 Key 加密存储，仅授权管理端可读。
同源检查、登录限流和修订号冲突检查保护后台写入；变更与审计同事务保存，不记录 Key 明文。

## 用户：如何下载和安装

```text
用户打开桌面市场
  → 市场按用户 Key / 组织过滤目录
  → 用户选择插件并确认安装
  → 下载接口再次检查上架状态、包身份和权限
  → 市场使用内部只读账号从 Verdaccio 取包
  → 返回压缩包，客户端安装到当前 Profile
```

自建插件的元数据和压缩包通过市场 `/registry/` 接口分发，权限不只是隐藏卡片。
未授权用户即使知道市场压缩包地址，也应被拒绝。
自有包的仓库直连限制为内部发布账号和市场服务账号；普通账号不能绕过市场读取。

客户端不会得到 Registry 内部账号。市场服务账号 `market` 只能读取，不能发布或删除包。
服务间凭据通过服务器秘密配置提供；Basic 账号凭据不会像短期 JWT 自动过期，但仍需保密和轮换。

安全边界：

- 自有插件必须落入仓库受控规则。`@tokensapi/*` 等规则仍保留迁移期 npm 回源；`@tokensapi-private/*` 不回源，详见 [Registry 规则](registry/README.md)。
- 已发布到公开 npm/GitHub 的内容，不能仅靠市场权限变为私有；已有下载和缓存副本无法收回。
- 撤权/下架不会自动删除用户本地代码，也不等于运行时业务授权；运行时许可应由插件自身服务验证。
- 数据库或授权服务异常不能回退到无权限过滤的静态目录，上游下载异常不能绕过授权。

## 更新、下架和删除

### 日常更新

```text
开发者修改和测试 → 提升版本 → 发布到同一仓库、同一包名
                                     ↓
                         市场刷新时发现稳定 latest
                                     ↓
                              用户执行插件更新
```

已上架 npm 插件自动跟随稳定 `latest`，包括历史标记为 pinned 的 npm 记录，不需要每次手工改市场版本。

- 查询时发现版本，不是发布后立即推送；缓存可能带来延迟。
- 不静默升级用户本地插件，不覆盖数据库登记资料、权限和审核记录。插件包提供 `tokenscowork.displayName`、`tokenscowork.summary` 多语言映射时，目录按 locale 展示文案；缺失或读取失败回退登记文案。
- 版本提示缓存 30 秒，同一查询合并请求；管理写入成功后失效。不缓存授权和下载结果。多语言文案另按包版本缓存最多 3 分钟。
- 不会自动上架草稿、已下架或回收站记录。
- Registry 无响应或 latest 为预发布版时，条目可能暂不展示，不用旧版本伪装成新版。
- 管理员更改包名、仓库、安装源或登记版本等关键字段可能使条目退回草稿，需要重新确认上架。
- 固定 Git commit 来源保持固定，不跟随 npm latest；公开 GitHub 不具备自建仓库的内容保密边界。

### 生命周期

| 操作 | 实际影响 | 不会做什么 |
| --- | --- | --- |
| 下架 | 停止新的市场展示和经市场的受控下载 | 不卸载用户本地插件 |
| 移入回收站 | 保留资料与授权，恢复后为草稿 | 不自动公开上架 |
| 彻底删除市场记录 | 确认完整 ID 后删除资料和相关授权，无法从后台恢复 | 不删除 npm 包、存储文件或用户本地插件 |
| 从 Registry 删除包/版本 | 内部发布人员单独管理仓库内容 | 不等于市场下架，可能让现有条目无法下载 |
| 用户卸载 | 移除当前用户 Profile 中的插件 | 不影响仓库或其他用户 |

彻底删除仍保留受保留期限制的审计和共享身份记录；重新创建同一 ID 不继承原插件授权。
安装、更新、卸载的生效时机以桌面提示为准，通常需要重启重新加载。

普通可选插件新增/更新无需重打桌面包；内置组件、宿主兼容性或客户端安装能力变更需要构建和发布桌面。

## 旧客户端兼容

旧域名继续代理请求，保留授权头和客户端能力头，但**旧 URL 可用不等于旧应用支持自建仓库**。

- 兼容来源：支持自建仓库的新客户端使用自建来源，旧客户端使用保留的公开 npm 版本。
- 仅自建来源：不向不支持该来源的旧客户端展示。
- 删除公开 npm 副本前，评估仍使用旧客户端的用户。
- `/roster.json` 仅为兼容 HTTP 路径，不是需要开发者维护的文件。

详见[新旧客户端来源兼容](server/CLIENT-SOURCES.md)。

## 内部实现：权限、数据库与 TokensAPI

一句话分工：**TokensAPI 管人**（谁是谁、属于哪个组织、是不是管理员），**市场管授权**（哪个插件给谁）。
授权、组织启停和组织开关都存在市场自己的数据库里，改完下一次请求立即生效。

### 代码分层

| 文件 | 职责 |
| --- | --- |
| `server/market-worker.js` | 总路由：目录 `/v1/plugins`、`/roster.json`，下载 `/registry/*`，管理接口 `/api/v1/*`，后台静态页 |
| `server/routes/api.js` | `/api/v1` 路由，每个接口先判定调用者能不能用 |
| `server/private-registry/routes.js` | 插件下载，先过权限判断，再用市场的服务账号去私有 Registry 取包 |
| `server/services/auth.js` | 调用者是谁：平台管理员 / 组织管理员，登录与会话 |
| `server/services/access.js` | **唯一的可见性判断**，目录和下载共用 |
| `server/services/plugins.js` | 插件资料、生命周期、访问范围与授权写入 |
| `server/services/organizations.js` | 对接 TokensAPI：同步组织、查 Key 归属（带缓存）、组织管理员登录校验 |
| `server/services/keys.js`、`users.js`、`audit.js` | Key 名录、用户名录、操作记录 |
| `server/integrations/tokensapi-organizations.js` | 对 TokensAPI 的 HTTP 调用与响应校验 |

### 数据库

SQLite（自托管 runtime，保留 D1 接口形状），开启 `foreign_keys`。业务表 10 张，另有两张迁移记录表：

| 表 | 作用 | 关键列 |
| --- | --- | --- |
| `market_plugins` | 插件，一行一个 | `id`、`visibility`（public / restricted）、`state`（draft / published / archived / deleted）、`metadata`（目录资料 JSON）、`revision` |
| `market_grants` | **全部授权都在这一张表** | `plugin_id`、`kind`（org / key / user）、`subject`，三列联合主键 |
| `market_organizations` | 从 TokensAPI 同步来的组织 | `id`、`name`、`enabled` |
| `market_org_hidden` | 组织管理员关掉的插件，有行即关 | `organization_id`、`plugin_id` |
| `market_org_members` | 组织管理员给某个插件指定的可见成员；没有行 = 全员可见 | `organization_id`、`plugin_id`、`user_id`、`name` |
| `market_keys` | Key 名录 | `fingerprint`（HMAC 指纹，主键）、`label`、`encrypted_value`（加密原文，仅供后台展示） |
| `market_users` | 可被授权的 TokensAPI 用户 | `id`、`name` |
| `market_sessions` | 后台会话 | `token_hash`、`organization_id`（平台管理员为 NULL）、`user_id`、`expires_at` |
| `market_audit_events` | 操作记录，只增不删，与变更同事务写入 | 操作者、动作、对象、详情 |
| `market_login_limits` | 登录失败限流 | |

- `market_grants.subject`：组织存组织 ID，用户存用户 ID，Key 存指纹。Key 原文从不作查询条件。
- 授权对象必须先在名录里：组织要先同步，用户要先加入用户名录，Key 要先登记。
- 清理：删除插件时，其授权、组织开关和指定成员由外键级联删除；删除 Key 或用户时，其授权在同一事务内一并删除。组织只同步不删除，停用即可。
- 并发：插件的 `revision` 是唯一的乐观锁，改资料、上下架、改访问范围、改授权都会加 1，版本号不符返回 409。

### 两种管理员

| | 平台管理员 | 组织管理员 |
| --- | --- | --- |
| 认证 | 后台口令：`Authorization: Bearer <口令>`，或用口令登录后台 | TokensAPI 用户 ID + 访问令牌登录 |
| 准入 | 口令正确 | TokensAPI 确认账号有效、组织角色 ≥ 10（Admin/Owner），且该组织已在市场登记并启用 |
| 能做什么 | 全部：插件、访问范围、授权、组织同步与启停、Key 与用户名录、操作记录 | 只看本组织，对平台授给本组织的插件开 / 关，或指定只给哪些成员（只能收窄） |
| 代码限制 | — | 平台接口经 `onlyPlatform()` 返回 403；组织接口经 `organizationId()`，只能访问会话里的那个组织 |

- 会话有效期 7 天。组织在市场被停用后，该组织的会话立即失效；更换后台口令或 HMAC 密钥，所有会话失效。
- 组织管理员的角色只在登录时向 TokensAPI 核对。在 TokensAPI 撤掉其管理员身份后，已有会话要等到期或退出才结束。
- 用会话 cookie 发起的写操作必须来自后台同源页面；Bearer 口令调用不受此限。

### 可见性判断（`services/access.js`）

```text
Key 能看到插件 P  ⇔  P 已上架，且满足任意一条：
  ① P 公开
  ② P 授给了这个 Key                       market_grants(kind='key',  subject=Key 指纹)
  ③ P 授给了这个 Key 的所属用户             market_grants(kind='user', subject=用户 ID)
  ④ P 授给了这个 Key 的所属组织              market_grants(kind='org',  subject=组织 ID)
       且该组织 enabled=1，且 market_org_hidden 中没有 (组织, P)，
       且 market_org_members 中 (组织, P) 没有行，或有这个 Key 所属用户的行
```

判断分两步，尽量少问 TokensAPI：

1. 只查本库：算出 Key 指纹，取它的单独授权（②），以及“哪些插件授给过任何组织或用户”。
2. 只有存在受限插件没被 ② 命中、而它又授给过组织或用户时，才向 TokensAPI 查 Key 归属，每次请求最多查一次；再判断 ③④。

目录（`filterRoster`）和下载（`allowed`）调用同一个 `decide()`，看得到就下载得了，看不到就下载不了。
内置组件由应用管理，不经过这里。

### 与 TokensAPI 的联动

| TokensAPI 接口 | 凭证 | 用途 |
| --- | --- | --- |
| `GET /api/current/organization` | 用户的 `sk-` Key | 查 Key 的所属组织和所属用户，用于 ③④ |
| `GET /api/organizations/all` | 市场的管理令牌（仅服务端） | 后台「同步组织」 |
| `GET /api/manage/users/search` | 同上 | 后台添加用户时搜索；指定组织成员时按返回的 `org_id` 只保留本组织的人 |
| `GET /api/user/self` | 组织管理员粘贴的访问令牌 | 登录时确认账号 |
| `GET /api/org/` | 同上 | 登录时取组织与角色（`my_role`） |

- **Key 归属缓存**：成功结果按 Key 指纹在进程内缓存 60 秒，失败不缓存。只有 TokensAPI 中 Key 换了组织或所属用户，市场最多晚 1 分钟生效。
- **超时与故障**：单次调用最多等 8 秒。TokensAPI 不可用时，持有单独 Key 授权的 Key 仍按 ② 返回；其余依赖 ③④ 的请求，目录和下载都返回 503，宁可报错也不多放行。
- **Key 或组织在 TokensAPI 停用**：该 Key 视为既无组织也无所属用户，③④ 都不命中。② 只认 Key 本身，不向 TokensAPI 核对。
- **同步组织**：只新增和改名，不会重新启用市场里停用的组织，也不会因某次同步缺少某个组织而删除它的授权；返回数据无效时整次放弃。
- 组织管理员的访问令牌只用于登录这两次调用，不保存、不缓存、不记录。

### 一次请求的路径

桌面端带 `sk-` Key 读 `/v1/plugins`：取全部已上架插件 → `filterRoster` 按上面两步逐个 `decide()` →
按客户端声明的来源能力过滤（兼容旧桌面）→ 补最新版本号，查不到版本的 npm 插件不列出 → 本地化 → 返回。
安装时走 `/registry/<插件ID>/<包名>`，先过同一个 `allowed()`，通过后由市场用服务账号从私有 Registry 取包，用户拿不到 Registry 凭证。

## 工程和部署边界

```text
market/
├── server/                  市场后台、目录、授权和下载代理
│   ├── admin/               管理页面和前端模块
│   ├── services/            插件、版本、组织、权限和审计逻辑
│   ├── routes/              管理 API
│   ├── private-registry/    市场内部 Registry HTTP 适配器
│   ├── integrations/       TokensAPI / npm 集成
│   ├── security/           会话、限流、Key 加密与指纹
│   ├── database/migrations/ 数据库迁移
│   ├── runtime/            自托管 Node 服务和 SQLite 适配
│   ├── ops/、tests/         开发工具和回归测试
│   └── docker-compose.yml  市场服务编排
├── registry/                独立 Verdaccio 服务、配置和账号脚本
└── legacy/                  旧 Cloudflare Pages 域名代理

build/modules/market/        构建时的桌面市场适配，不直接修改上游子模块
```

当前自托管部署分为两个服务，HTTPS/Nginx 由运维管理：

| 服务 | Compose 位置 | 本机监听 | 持久数据 |
| --- | --- | --- | --- |
| 市场 | `market/server/` | `127.0.0.1:4880` → 容器 `8080` | `tokenscowork-market-host-data`，包含 SQLite `market.sqlite` |
| 仓库 | `market/registry/` | `127.0.0.1:4873` → 容器 `4873` | Registry storage/plugins volumes |

业务保留 Worker/D1 接口兼容，但自托管 runtime 使用 SQLite，不能把当前部署描述为全部运行在 Cloudflare D1。
`.github/workflows/market.yml` 部署的是旧域名代理，不会自动更新服务器上的市场或 Registry 容器。

`private-registry/` 不是第三个独立服务。市场通过 HTTPS 和内部账号访问 Registry，不读取它的账号文件或存储目录。
迁移机器需分别保留数据库、仓库存储、秘密配置及反代配置，不能仅复制代码。

可选插件资料和权限由数据库维护。`product.json` 生成的 `server/product-components.json` 用于后台只读展示内置组件和保护内置身份，不是可选插件名册，也不代表用户本机版本。详见 [内置归档](registry/BUILTINS.md)。
历史种子迁移不能作为新增插件入口；新增插件走后台。

运维参考：[Registry](registry/README.md)、[市场部署](server/DEPLOY.md)、[TokensAPI](server/TOKENSAPI.md)、[管理 API](server/SERVICE-API.md)。
当前部署使用 [市场 CI 部署说明](deploy/README.md)：测试、固定提交构建、数据库备份和健康检查。历史报告仅供排障参考，不作为当前部署命令。

## 开发与验证

在仓库根目录执行，使用项目要求的 Node 版本：

```powershell
npm --prefix market/server run build
npm --prefix market/server run verify
npm --prefix market/server run dev:check
npm --prefix market/server run dev
```

`build` 生成源 manifest 和产品组件身份文件，不生成可选插件静态名册，也不等于上线。
本地演示监听 `127.0.0.1:8788`，使用虚构组织和内存数据库。不要输入真实 Key，不要把演示结果当作正式组织授权验收。
本地凭证使用本地环境配置，不在 README 中约定共享生产密码。

## 验收状态

以下来自 [历史回归](docs/regression-2026-09-11.md) 和 [路由修复记录](docs/routing-fix-2026-09-14.md)，不代表当前版本仍全部存在，完整客户端验收需重新执行：

- 多插件冷缓存卸载丢失市场 Registry 参数，错误查询公开 npm 并报 404。
- Agent 原生 `dsh plugin add` 不会自动选择市场来源和鉴权，不能承诺裸命令自动安装私有插件。
- 共享路由曾以额外 staging 补丁部署，普通 Compose 重建存在遗漏风险，需核对客户端、后端和部署流程。
- 插件本体自托管不代表第三方依赖均已加速，客户端仍可能直连公开 npm，冷缓存下载出现过超时。

发布验收至少覆盖：公开/受限目录、无权直链拒绝、正式组织与单独 Key 授权及撤销、新旧来源兼容、
冷缓存多插件安装/更新/卸载、重启加载，以及重新部署后的路由一致性。
不能仅以页面正常、单测通过或缓存命中安装作为完整验收。

**对外口径：核心管理和受控分发架构已建立，日常插件发布与桌面发版解耦；已知路由、部署和下载稳定性问题仍需完成修复验收。**
