# 插件市场组织可见域设计

## 补充：组织与独立 Key 并行授权（2026-09-08）

组件分类由名册 `category: builtin | optional` 维护，和公开/受限分别筛选。
当前直接合入 Desktop patch 的更新、品牌 UI、模型管理、联网搜索为内置组件：
后台仅展示、标注随应用更新，权限写入接口拒绝修改。其余为可选插件，保留组织/Key 配置。
这不是改变桌面安装机制，也不将“默认启用”普遍等同于“不可卸载”；以后若装配机制改变，需同步调整名册和分类测试。

以下规则优先于下文组织单一授权方案：

- 每个插件可同时选择组织和录入单独 API Key，任一命中即可访问；两者皆空才公开。清空受限插件需要再次确认。
- 管理页面改为卡片、搜索与公开/受限筛选；没有凭证输入框。用户已明确同意临时免登录管理，服务端以 `MARKET_ADMIN_MODE=open` 显式开启。默认不设置仍要求管理员凭证。开放期间任何人都能查看组织名录、修改授权，不适合作为正式企业安全边界。
- `PUT /api/admin/plugin-access` 接收 `{id,metadata,objectKey,organizationIds,apiKeys,keepFingerprints,confirmPublic}`。Key 仅持久化 HMAC 指纹，新增表 `market_plugin_key_grants`；管理响应不返回明文。
- 独立 Key 无需组织提供方；组织服务异常时仍返回该 Key 明确获准的插件，不泄露组织专属插件。独立 Key 授权以市场内移除为准，不会自动查询 TokensAPI 的 Key 撤销或过期状态。
- 已迁移插件不会恢复旧 Key 规则。旧有效 Key 可在首次保存时明确保留，转为本页的独立授权；其后由本页移除。
- `GET /api/admin/roster` 通过管理权限读取原始名册，避免组织接口故障导致管理页面无法加载。目录与私有下载仍使用客户权限检查。
- 组织自动识别仍等待真实 TokensAPI 文档；公开 npm / GitHub 包并未变为私有。

## 当前实施约定（2026-09-08）

用户确认保留权限，改为按 TokensAPI 组织管理。以下约定取代后文的旧市场令牌与独立来源方案；后文仅保留为历史参考。

- 桌面通过 `Authorization: Bearer <API Key>` 请求同一个产品市场。沿用已有构建覆盖的凭证透传，不在客户端读取组织列表或决定组织权限。
- 市场后端调用 TokensAPI 的 Key 查询组织接口，获取数字组织 ID 和名称。组织 ID 是授权依据，名称仅用于展示；不信任客户端提交的组织 ID。
- 管理后台每个插件选择允许的组织。未配置组织表示公开；配置一个或多个组织表示仅这些组织可见。同组织所有有效 Key 共享权限，无需逐 Key 录入。
- 所有组织列表由市场后端使用专用后台凭证查询，只向已通过管理员鉴权的管理页面提供。专用凭证保存在服务端，不分发给桌面或浏览器。
- 组织查询失败、Key 无效或组织不匹配时不得返回受限插件。组织接口异常与正常的无权限状态需区分，不回退到包含受限插件的静态目录。
- 每次市场请求最多解析一次组织，供该次目录过滤使用。初版不引入跨请求身份缓存，避免 Key 撤销或组织变化后仍沿用旧权限。
- 下载入口复用同一组织权限判断。当前公开 npm/GitHub 包仍可从原地址下载；严格限制包下载需要私有分发和桌面安装适配，不能仅靠隐藏目录实现。
- 保留现有 Key 授权数据，明确迁移后再切换；不得在迁移过程中把原受限插件因没有组织配置而自动公开，也不得将旧 Key 授权作为组织鉴权失败后的兜底。

### 尚待 TokensAPI 提供的实际接口定义

聊天记录确认接口将提供，但尚未包含接口地址或完整契约；仓库内亦未找到对应文档。接入前需要：

1. Key 查询组织：URL、HTTP 方法、Key 传递方式、成功返回示例、无效 Key/无组织/多组织时的返回约定。
2. 后台组织列表：URL、HTTP 方法、专用鉴权方式、分页参数及返回示例。
3. 数字组织 ID 的取值范围；如可能超过 JavaScript 安全整数范围，需要约定无损传输形式。

### 我方功能已实现（外部接口独立待接）

- `/admin/`：管理登录、组织名录、登记/编辑/停用组织、每个插件配置允许的组织、受限改公开时明确确认。
- `PUT /api/admin/organizations`：`{id: 数字, name: 字符串, enabled: 布尔}`。
- `PUT /api/admin/plugin-organizations`：`{id, metadata, objectKey, organizationIds: 数字数组, confirmPublic?: true}`。组织必须先登记，空数组表示公开；受限插件改公开必须明确确认。一次事务替换该插件的组织策略。
- `GET /api/admin/access`：额外返回 organizations、organizationPolicies、organizationGrants、organizationProviderReady、organizationListReady，仅管理员可读。
- `PUT /api/admin/organizations/sync`：后台组织列表接入后可同步。同步保留本地停用状态，不因列表遗漏删除已有授权；未接入返回 503。
- `market/scripts/organization-schema.sql` 是可重复运行的新增表迁移，发布流程先迁移再部署。不会更改旧插件可见范围或清除旧 Key 数据；只有管理员保存某插件时，该插件才改用组织策略。
- 目录每个请求只查询一次身份；下载逐次复用组织判断。查询失败返回 503、无效身份无受限权限、不允许旧 Key 规则绕过组织策略。

`market/organizations.js` 是唯一的外部组织适配入口。目前定义的是**我方内部契约**，并非猜测 TokensAPI URL：

```js
// 私有后端依赖，测试时注入；线上尚未连接实际提供方。
MARKET_ORGANIZATIONS.resolveOrganization(apiKey) // -> { id: number, name: string } 或 null
MARKET_ORGANIZATIONS.listOrganizations() // -> [{ id: number, name: string }]
```

收到实际文档后在适配模块内实现 HTTP、鉴权和响应转换，列表接口需聚合其分页。其他权限代码及管理 UI 不依赖 TokensAPI 的原始字段。外部接口调用当前限制 8 秒；测试身份仅在内存测试中注入，线上没有测试 Key 映射入口。

运行 `node --test market/tests/access.test.mjs` 验证组织隔离、多个 Key 共用组织、迁移保护、撤销、下载鉴权、未接入状态、组织同步和旧 Key 兼容。当前可先保存后台组织配置；真实客户组织的自动识别仍需接入外部接口。

## 历史方案（已被上述约定取代）

目标：同一个市场服务，不同组织的客户看到「通用插件 + 本组织专属插件」。
组织身份由 TokensAPI 后端从 API Key 解析（apikey → orgId），市场侧不直接
消费 API Key。

## 一、总体结构

```
客户端市场 Host ──GET──▶ Cloudflare Worker（市场源）
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
        KV: roster:common  KV: roster:org:<id>  KV: tok:<token> → orgId
        （通用名册）        （组织专属名册）      （市场令牌映射）
                              │
                              ▼
                    TokensAPI 后端（发令牌时用 apikey 查 orgId）
```

## 二、URL 设计（兼容市场标准源契约）

市场契约要求端点以 `/v1/plugins` 结尾、与 manifest 同源。组织令牌放路径
前缀，两条路径同构：

| 路径 | 可见域 |
|---|---|
| `/source.json`、`/v1/plugins` | 仅通用名册（现状不变，普通客户零感知） |
| `/t/<token>/source.json`、`/t/<token>/v1/plugins` | 通用 ∪ 该组织名册 |

- `<token>` 是**市场令牌**（如 `mkt_` + 32 位随机），不是 API Key。
  API Key 属于计费凭据，进 URL 会落进各级访问日志；令牌只有「读本组织
  目录」一个权限，可随时吊销重发。
- 令牌无效/过期时 fail-open 到通用目录（客户市场不空白，只是看不到专属件）。

## 三、KV 数据模型

| Key | 值 | 说明 |
|---|---|---|
| `roster:common` | roster JSON（与现 `market/roster.json` 同构） | 通用名册 |
| `roster:org:<orgId>` | 同构 roster JSON | 组织专属名册，仅含专属插件 |
| `tok:<token>` | `{ "orgId": "...", "note": "...", "createdAt": "..." }` | 令牌 → 组织 |

- 名册条目结构与现有 roster.json 完全一致（id/package/displayName/summary/
  repository/version/npm），Worker 逻辑复用。
- 静态 `market/roster.json` 保留为通用名册的兜底与 git 审计副本；
  Worker 读 KV 失败时回退静态文件（沿用现有 fail-open 链）。

## 四、Worker 逻辑（在现有 _worker.js 上扩展）

```
GET /t/<token>/v1/plugins:
  1. KV 查 tok:<token> → orgId；查不到 → 按通用目录返回
  2. 名册 = roster:common ∪ roster:org:<orgId>（id 冲突时组织条目覆盖）
  3. 逐包实时查 npm dist-tags.latest（复用现有 latestStableVersion）
  4. 响应缓存按 token 维度隔离（cacheKey 含 token）

GET /t/<token>/source.json:
  基于静态 source.json 改写 transport.endpoint 为
  https://<origin>/t/<token>/v1/plugins（同源约束保持成立）
```

## 五、令牌签发流程

阶段一（基础版，人工）：
1. 企业客户提供其 API Key（或你在后台已知其组织）
2. 你在 TokensAPI 后台用 apikey 查出 orgId
3. 生成随机令牌，写入 KV：`tok:<token> → { orgId }`
4. 把 `https://<origin>/t/<token>/source.json` 交给客户

阶段二（自动化，后续）：TokensAPI 后端提供
`POST /market/token`（Authorization: apikey）→ 返回该组织的市场令牌；
客户在自己的控制台自助获取。

## 六、客户端接入

产品打包目前隐藏了市场「添加标准来源」按钮（`build/overlays/
market.mjs` 覆盖 3）。启用组织源需要二选一：

- **恢复添加按钮**（推荐，改动最小）：企业客户拿到 URL 后在
  设置 → 插件市场 → Sources 自行添加并选中。普通客户不受影响。
- 企业定制安装包：装配时把组织源预置为默认（成本高，留给大客户）。

## 七、安全边界（明确不承诺的事）

- **可见域 ≠ 保密**。目录只控制「谁看到卡片」；`npm: true` 的包发布在
  公开 registry，知道包名即可下载。含客户业务逻辑的真私有插件不走此
  通道（用私有 git + `dsh plugin add <git-spec>`，或定制安装包）。
- 令牌泄露的最大损失 = 泄露该组织目录清单；不涉及安装能力提升
  （安装核验仍由客户端 Host 对 npm 独立执行）。

## 八、实施顺序

1. Pages 项目绑定 KV namespace；`roster:common` 用现 roster.json 灌入
2. `_worker.js` 增加 `/t/<token>/*` 路由与名册合并
3. `market.yml` CI 部署后自检增加一条带测试令牌的组织目录断言
4. 恢复市场「添加来源」按钮（改 overlays/market/market-source-overlay.mjs，随下个产品发版生效）
5. 管理面板增加按令牌查看组织目录的入口（只读即可）
6. （后续）TokensAPI 后端自动签发令牌 + 面板可写化

## 九、当前结论（2026-08-28）

暂缓实施。已查明的关键事实:

- 现有参数链做不到:客户端市场 Host 拉源是裸 GET 不带 apikey;
  new-api key 认证接口(/api/usage/token/)返回里没有 group 字段。
- 三条可行路(任选其一即可落地,代价已在上文):
  1. 客户端装配补丁带 key + 令牌名约定 org-<组织>(统一源,可行性未验)
  2. /t/<令牌>/ 路径入口(服务端代码曾上线并验证,见 commit 7a4caeb,已 revert)
  3. new-api GetTokenUsage 响应加一行 group 字段(最干净的身份来源)
- 触发条件:第一个企业客户需求落地时,按其实际形态选路。
