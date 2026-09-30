# 市场管理 API（`/api/v1`）

市场只有这一套管理接口：后台页面用它，TokensAPI 后端、脚本和 Swagger 也用它。
**市场只负责插件**：身份、用户和组织的事实来源在 TokensAPI，市场按组织号（TokensAPI 的组织 ID）记录授权，
不复制用户表，不存储任何原始 Key（单独登记的 Key 只存不可逆指纹，原文加密保存以便后台复制）。

基址 `https://market.tokensapi.ai/api/v1`。所有请求和响应为 JSON；请求体上限 16 KB。

可交互的接口参考在 `/admin/api-docs.html`（生产 <https://market.tokensapi.ai/admin/api-docs.html>），
由 `admin/assets/openapi.json` 渲染。渲染器（Swagger UI 5.33.0）整份放在 `admin/assets/vendor/`，
页面只加载同源文件，断网也能打开，也不会把文档地址交给任何第三方校验服务。
文档页本身不含任何凭据，公开可读，接口地址用相对路径 `/api/v1`，即总是调用打开它的那个实例。
文档页默认沿用后台的登录会话：先在后台登录（口令，或 TokensAPI 用户 ID + 访问令牌），再打开文档页，「Try it out」就以该身份调用，
页面顶部会写明当前身份。组织管理员同样可用，只是平台接口返回 `403`。也可以点「Authorize」粘后台口令，只存在于当前标签页，
带了口令时以口令为准。本地开发实例（`npm run dev`）会从仅它才有的 `/__dev/docs-credential` 自动预填口令。

`/v1/plugins`、`/roster.json`、`/source.json`、`/registry/*` 是给桌面端的消费接口，不在本文范围内，形状保持不变。

## TokensAPI 接入速查

所有请求带 `Authorization: Bearer <后台口令>`（见下文「认证」），身份等同平台管理员，口令只能放在服务端。常用的就这几步：

| 要做的事 | 请求 |
| --- | --- |
| 看有哪些插件 | `GET /plugins` → `items[].id`，`items[].visibility` 为 `public` 或 `restricted` |
| 登记组织 | `POST /organizations/sync`（从 TokensAPI 拉全量），或 `PUT /organizations/{orgId}` `{"name":"…","enabled":true}` |
| 给组织配插件 | `PUT /organizations/{orgId}/grants` `{"plugins":["a","b"]}` |
| 给某个用户配插件 | 先 `PUT /users/{userId}` `{"name":"…"}` 登记，再 `PUT /users/{userId}/grants` `{"plugins":["a"]}` |
| 查组织实际能用哪些 | `GET /organizations/{orgId}/plugins`，`visible` 为 `true` 的就是 |
| 代组织管理员开关、指定成员 | `PUT /organizations/{orgId}/plugins/{pluginId}` `{"enabled":false}` 或 `{"members":[102]}` |

- `grants` 是**全量替换**：传的就是最终名单，空数组即全部撤销。组织、用户须先登记，否则 `404`。撤掉某个组织的授权时，该组织对这个插件的开关和成员名单一并清掉，再授予即从全员可见重新开始。
- 授权只对**受限**插件起作用，公开插件人人可见；公开/受限由 `PUT /plugins/{pluginId}/access` 或后台设置。
- 可选：代某个组织管理员操作时带上 `X-TokensAPI-Operator-Id`（操作人用户号）和 `X-TokensAPI-Operator-Org-Id`（其组织号），操作记录会写成「TokensAPI 代用户 N · 组织 #M」。这两个头只作记录，不影响权限：市场只认口令，操作人是否该组织的管理员由 TokensAPI 自己把关。
- 标着「后台专用」的接口（登录、退出、导入 npm 资料）是后台页面自己用的，TokensAPI 不需要调。

## 认证

两种方式，服务端按请求决定身份：

| 方式 | 身份 | 用途 |
| --- | --- | --- |
| `Authorization: Bearer <后台口令>` | 平台管理员 | TokensAPI 后端、脚本、Swagger |
| `__Host-market_session` Cookie | 平台管理员或组织管理员 | 后台页面，由 `PUT /session` 签发 |

- 后台口令就是 `MARKET_ADMIN_TOKEN`，开发与生产同一套机制，没有单独的服务凭据。
- **带了 Bearer 就只看 Bearer**：口令错了直接 `401`，不会退回去用同一请求里的 Cookie。
- 走 Cookie 的写请求（非 GET）必须带同源 `Origin`，否则 `403`；Cookie 本身是 `SameSite=Strict`。这样浏览器会话进同一套接口也没有 CSRF 面。
- 失败限流：同一边缘 IP 在 15 分钟窗口内累计 8 次失败后返回 `429`，响应体 `retryAfter` 和 `Retry-After` 头给出秒数。
  Bearer 口令与后台登录（`PUT /session`）是**两个独立的桶**：脚本里口令打错不会把人工登录锁在门外，反之亦然。
  不带任何凭证的请求（如未登录时打开页面）不计入失败。

### 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/session` | 当前身份。未登录 `{authenticated:false, tokensapiLogin}`；已登录 `{authenticated:true, role, organizationId, organizationName, userId}`，平台管理员另带 `environment`（各项上游是否就绪，不含任何凭据） |
| PUT | `/session` | 登录。体为 `{credential}`（后台口令），或 `{tokensapi:true, userId, accessToken}`（组织管理员，见 [TokensAPI 集成](TOKENSAPI.md#组织管理员身份)）。成功 `{ok:true}` 并下发 Cookie（7 天） |
| DELETE | `/session` | 退出，清掉 Cookie |

`role` 为 `platform` 或 `organization`。**普通成员、无组织账号、组织未登记或已停用一律 `401`**，后台没有只读席位。

## 端点

| 方法 | 路径 | 组织管理员 |
| --- | --- | --- |
| GET / POST | `/plugins` | ✗ |
| GET / PATCH | `/plugins/:id` | ✗ |
| PUT | `/plugins/:id/access` | ✗ |
| POST | `/plugins/:id/{publish,archive,trash,restore,purge}` | ✗ |
| GET | `/organizations` | ✗ |
| POST | `/organizations/sync` | ✗ |
| GET | `/organizations/:orgId` | ✓（限本组织） |
| PUT | `/organizations/:orgId` | ✗ |
| GET | `/organizations/:orgId/grants` | ✓（限本组织） |
| PUT | `/organizations/:orgId/grants` | ✗ |
| GET | `/organizations/:orgId/plugins` | ✓（限本组织） |
| PUT | `/organizations/:orgId/plugins/:pluginId` | ✓（限本组织） |
| GET | `/organizations/:orgId/members?keyword=` | ✓（限本组织） |
| GET / POST | `/keys` | ✗ |
| GET / PATCH / DELETE | `/keys/:fingerprint` | ✗ |
| GET / PUT | `/keys/:fingerprint/grants` | ✗ |
| GET | `/users` | ✗ |
| GET | `/users/search?keyword=&page=` | ✗ |
| GET / PUT / DELETE | `/users/:userId` | ✗ |
| GET / PUT | `/users/:userId/grants` | ✗ |
| GET | `/audit` | ✗ |
| GET | `/npm-package?name=&registry=&version=` | ✗ |

组织管理员访问 ✗ 的接口或别的组织号返回 `403`。未列出的方法返回 `405`，未知路径返回 `404`。

### 插件

`GET /plugins` → `{ publisher, components, items: [ … ] }`。`components` 是应用内置组件（只读，由客户端发布决定，
不能上下架也不能配权限）；`items` 是市场管理的插件，每条除资料外还带 `effectiveRegistry`（本实例实际给桌面的来源）
与 `npmLatestVersion`（已上架 npm 插件当前的稳定 latest）。`GET /plugins/:id` 返回单条：

```json
{
  "id": "example-tool", "package": "@tokensapi/example-tool",
  "displayName": "示例插件", "summary": "说明插件解决什么问题",
  "version": "1.0.0", "npm": true, "registry": "tokenscowork",
  "repository": "https://github.com/TokensAPI/example-tool",
  "visibility": "restricted", "state": "published",
  "revision": 3, "versionMode": "latest", "reviewedVersion": "1.0.0",
  "access": { "organizations": [7], "keys": ["<64 位指纹>"], "users": [102] }
}
```

`state` 为 `draft | published | archived | deleted`；`visibility` 为 `public | restricted`。

`revision` 是这条插件**唯一的**乐观锁：资料、生命周期、访问配置共用它。除新建外，每个写请求都要带上你读到的 `revision`；
不匹配返回 `409`，重新读取后再试。写成功后 `revision` 加一，响应里会带回新值。

新建：

```http
POST /api/v1/plugins
{ "id": "example-tool", "metadata": { "package": "@tokensapi/example-tool",
  "displayName": "示例插件", "summary": "…", "version": "1.0.0", "npm": true, "registry": "tokenscowork",
  "repository": "https://github.com/TokensAPI/example-tool" } }
```

→ `{ "ok": true, "state": "draft", "revision": 1 }`。新建总是草稿、访问范围为 `public`，草稿不会出现在任何人的目录里；
要做成受限插件，建完再调一次 `PUT /plugins/:id/access`。资料可以先用 `GET /npm-package?name=<包名>` 从 npm 读出来再改。

- `npm: true` 时 `registry` 取 `npm`（公开 npm）或 `tokenscowork`（自建仓库），版本跟随稳定 `latest`。
- `npm: false` 表示 GitHub 来源，必须给 `installSource.commit`（完整 40 位），版本固定不跟随。
- 与应用内置组件同 ID 或同包名返回 `409`；ID 已存在（含回收站）返回 `409`。

编辑：`PATCH /plugins/:id`，体为 `{ "revision": 3, "metadata": { … } }`。**改动包名、来源或安装源会把条目退回草稿**，需要重新上架。

生命周期：`POST /plugins/:id/<操作>`，体为 `{ "revision": 3 }`，返回 `{ ok, state, revision }`。

| 操作 | 前置状态 | 备注 |
| --- | --- | --- |
| `publish` | `draft` / `archived` | 访问范围为公开时须加 `"confirmPublic": true`，否则 `409`；预发布版本不能上架，npm 来源须已有稳定 `latest` |
| `archive` | `published` | 停止展示与受控下载，不卸载用户本地插件 |
| `trash` | `archived` | 移入回收站，保留资料与授权 |
| `restore` | `deleted` | 恢复为草稿，不会自动上架 |
| `purge` | `deleted` | 须加 `"confirmId": "<完整插件 ID>"`，删除后无法恢复；返回 `{ ok, state: "purged" }` |

顺序不对返回 `409`。

### 访问配置

一个请求写完整个访问配置：

```http
PUT /api/v1/plugins/example-tool/access
{ "visibility": "restricted", "organizations": [7, 9], "keys": ["<指纹>"], "users": [102], "revision": 3 }
```

→ `{ "ok": true, "visibility": "restricted", "revision": 4 }`。`organizations`、`keys`、`users` 是**全量替换**，各最多 100 个；
组织必须已在市场登记（先 `sync`），Key 必须已在 `/keys` 登记，用户必须已在 `/users` 登记，否则 `400`。
`users` 可以不传，不传即清空。回收站里的条目先恢复再改，否则 `409`。

公开插件也可以保留授权：改回受限时原样生效。

### 按组织 / Key / 用户配置插件

上面是从插件这一侧配；也可以从授权对象那一侧，一次配完它能用的插件。三处形状相同：

| 路径 | 授权对象 |
| --- | --- |
| `/organizations/:orgId/grants` | 一个组织（组织管理员可以读本组织，写只有平台） |
| `/keys/:fingerprint/grants` | 一个 Key |
| `/users/:userId/grants` | 一个用户 |

`GET` → `{ "plugins": ["example-tool"] }`（不含回收站里的插件）。

```http
PUT /api/v1/users/102/grants
{ "plugins": ["example-tool", "another-tool"] }
```

→ `{ "ok": true, "plugins": [ … ] }`。**全量替换**，传空数组即全部撤销，最多 500 个；插件必须存在且不在回收站，
对象必须已登记，否则 `400` / `404`。授权有变化的每条插件 `revision` 加一（所以同时开着的插件访问对话框再保存会拿到 `409`，
刷新即可）。不改插件的公开/受限：授给公开插件的记录会保留，但要等插件改成受限才起作用。

### 访问判定

**几个来源相互独立，任意一个命中就可见**：

```
可见  ⇔  已上架  且  (
      访问范围为公开
   或 插件授权给了这个 Key
   或 插件授权给了 Key 的所属用户
   或 (插件授权给了 Key 所在组织  且  该组织启用  且  组织管理员没把它关掉) )
```

- 访问范围（`public | restricted`）只由平台管理员设置。授权谁、撤谁，都不会移动它。
- 单独 Key 授权只管这一个 Key，组织和组织开关都影响不到它。
- 用户授权跟着人走：该用户名下的每个 Key 都命中，组织和组织开关同样影响不到它。
- Key 的所属组织与所属用户由 TokensAPI `/api/current/organization` 一次解析；只有在答案取决于它们时才会去问上游。
  解析结果在进程内按 Key 指纹记 60 秒（失败不记）：后台改授权、组织启停与开关立即生效，只有 TokensAPI 里 Key 换了组织或所属用户最多晚 1 分钟。

### 组织

`GET /organizations` → `{ items: [{ id, name, enabled, granted, hidden }], syncReady }`，`granted` 是授给该组织的插件数，
`hidden` 是组织管理员关掉的数量，`syncReady` 表示是否配置了 TokensAPI 组织列表。

`GET /organizations/:orgId` → `{ id, name, enabled }`。`PUT /organizations/:orgId` 体为 `{ "name": "Seven", "enabled": true }`，
登记或更新一条组织记录，返回 `{ ok: true }`。`enabled: false` 立刻停掉该组织的全部组织授权，并让该组织管理员的会话失效。

`POST /organizations/sync` 从 TokensAPI 拉全量组织名录，返回 `{ "count": 12 }`。同步保留本地停用状态与既有授权，
不因上游缺项删除数据。未配置 `MARKET_ORGANIZATIONS_TOKEN` 返回 `503`。

### 组织内的开关

平台把插件**授予**组织之后，组织管理员可以决定**给不给自己的成员看**——只能收窄，永远不能放宽。

`GET /organizations/:orgId/plugins` →

```json
{ "organizationId": 7, "items": [
  { "id": "example-tool", "displayName": "示例插件", "package": "@tokensapi/example-tool", "summary": "…",
    "version": "1.0.0", "source": "organization", "switchable": true, "enabled": true,
    "members": [ { "id": 102, "name": "Alice" } ], "visible": true } ] }
```

列出该组织成员能看到的已上架插件：`source` 为 `public`（公开，不可关）或 `organization`（授给本组织，可关）；
`visible` 是开关与组织启用状态合起来的结果，即该组织会拿到的插件；`members` 为空表示全员可见，
不为空时只有名单里的成员能看到（有单独 Key 或用户授权的人不受名单限制）。这条接口按组织号回答，
不需要任何成员 Key，适合 TokensAPI 自己的界面直接展示。

`PUT /organizations/:orgId/plugins/:pluginId` 体为 `{ "enabled": false }`、`{ "members": [102, 103] }` 或两者一起，
→ `{ ok: true, enabled, members: [{ id, name }] }`。`members` 是可见成员的用户 ID（不重复，最多 200 个），整体替换原名单，
空数组恢复全员可见；新加入名单的用户须经 TokensAPI 确认属于本组织，否则 `400`，未配置用户搜索时 `503`。
公开插件、没授给本组织的插件返回 `400`；内置组件返回 `409`；插件不存在或未上架返回 `404`。

`GET /organizations/:orgId/members?keyword=alice` → `{ items: [{ id, name, username }], more }`：在 TokensAPI 按用户名、
显示名或用户 ID 搜索，只返回本组织成员，供指定成员时挑选。一次读 100 条匹配结果再过滤，`more` 为 `true` 时换更具体的关键词；
结果不落库，未配置或上游不可用 `503`。

### Key

单独授权用的 `sk-` Key 名录。登记后才能在访问配置里勾选。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/keys` | `{ items: [{ fingerprint, apiKey, label, createdAt, stored, plugins }], displayReady }`；`apiKey` 是解密后的原文（没存或解不开为 `null`），`plugins` 是单独授给它的插件；`fingerprint` 只作接口里的 Key 标识 |
| POST | `/keys` | `{ key: "sk-…", label }` → `{ ok, fingerprint }`；已登记返回 `409` |
| GET | `/keys/:fingerprint` | 单个 Key，字段同上 |
| PATCH | `/keys/:fingerprint` | `{ label }`，最多 120 字 |
| DELETE | `/keys/:fingerprint` | 删除 Key，**连同它的所有插件授权** |

### 用户

单独授权用的 TokensAPI 用户名录。账号在 TokensAPI，市场只记用户号和一个显示名。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/users` | `{ items: [{ id, name, createdAt, plugins }], searchReady }`；`searchReady` 表示本实例能否在 TokensAPI 搜用户 |
| GET | `/users/search?keyword=alice&page=1` | 转发 TokensAPI 用户搜索 → `{ items: [{ id, name, username }], total }`，结果不落库；未配置或上游不可用 `503` |
| GET | `/users/:userId` | 单个用户，不存在 `404` |
| PUT | `/users/:userId` | `{ name }`（最多 200 字），不存在时登记，存在时改名 |
| DELETE | `/users/:userId` | 移除用户，**连同它的所有插件授权** |

### 操作记录

`GET /audit` → 最近 100 条，新的在前：`{ items: [{ id, action, target, actor: { kind, id, organizationId }, details, createdAt }] }`。
`actor.kind` 为 `root`（后台口令；`id` 为 `token` 或 `session` 区分 Bearer 与后台登录）或 `tenant`（组织管理员，`id` 为 TokensAPI 用户号）。

每一次写入都与它的审计记录在同一个事务里：审计写不进去，改动本身也回滚（`503`）。审计里只有指纹、组织号和用户号，任何情况下不含 Key 明文或口令；表里只保留最近 5000 条。

## 错误

| 状态 | 含义 |
| --- | --- |
| `400` | 请求体或字段无效（包括不是 JSON 对象的请求体） |
| `401` | 未登录或口令无效 |
| `403` | 组织管理员越权，或 Cookie 写请求不同源 |
| `404` | 插件、组织、Key、用户或路径不存在 |
| `405` | 该路径不支持此方法 |
| `409` | 修订号冲突、状态机顺序不对、重复登记、或缺少明确确认 |
| `429` | 失败限流，见 `Retry-After` |
| `502` | npm 资料读取失败 |
| `503` | 数据库或上游组织服务未配置/不可用 |

响应体统一为 `{ "error": "中文说明" }`。错误消息面向运维排障，不要用它做程序分支——请用状态码。

**幂等性**：带 `revision` 的写靠它保证不会重复生效——同一个 `revision` 只会成功一次，重试会拿到 `409` 而不是二次写入。
`POST /plugins` 与 `POST /keys` 不幂等：重复创建返回 `409`。

## 改了接口之后

`openapi.json` 是这套路由的第二份描述，所以它不靠自觉维护——`npm run verify` 会从三个方向逼它跟上，
不一致就是红的（`tests/openapi-conformance.test.mjs`）：

| 你改了什么 | 哪个测试会红 |
| --- | --- |
| 加了一条路由 / 加了一个资源名 | 「every resource the router matches on is documented」 |
| 删了或改名了一条路由 | 「every operation in the OpenAPI document reaches a real route」 |
| 改了响应字段：新增、改名、换类型、动了 required | 「what the routes actually answer matches the schema documented for it」 |

第三个测试拿真实响应去比对文档里为**那一条路径、那个方法、那个状态码**声明的 schema，并且**多一个字段也算不一致**。
它只覆盖测试夹具能造出来的响应；要覆盖新端点，在 `probes` 表里加一行即可，schema 是从文档里查出来的，不用重写。

更新渲染器：重新下载 `swagger-ui-dist` 的 `swagger-ui.css` 与 `swagger-ui-bundle.js` 覆盖 `admin/assets/vendor/`，
去掉 CSS 末尾的 `sourceMappingURL` 注释（对应的 `.map` 我们不发），改一下 `api-docs.html` 里的版本号注释。
`ops/market-check.mjs` 不扫 `vendor/`，那是第三方压缩产物。

## 与 TokensAPI 的分工

| 事项 | 归属 |
| --- | --- |
| 用户、登录、组织成员关系 | TokensAPI |
| 组织号与组织名 | TokensAPI（市场按需同步一份只读副本） |
| 谁是某组织的管理员 | TokensAPI 的组织角色（`my_role >= 10`）；市场不维护指派表 |
| 插件资料、上下架状态 | 市场 |
| 用户号、用户名、Key 属于哪个用户 | TokensAPI（市场只存被授权过的用户号和显示名） |
| 插件的访问范围与授权（组织 / Key / 用户） | 市场（TokensAPI 可经本 API 代管） |
| 组织内部对成员的可见性 | 市场的组织开关（组织管理员自行配置） |
