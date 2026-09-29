# TokensAPI 组织集成

## 服务端配置

- `MARKET_ORGANIZATIONS_BASE_URL`：生产使用 `https://tokensapi.ai`，测试使用 `https://dev.tokensapi.ai`，不跨环境自动回退。
- `MARKET_ORGANIZATIONS_TOKEN`：组织列表专用固定 Token，写在服务器 `.env`；不写入代码、前端或提交记录，不复用后台登录密码。

配置完成后部署市场。后台显示组织身份已接入，管理员在「组织」页点「同步组织」，再在插件的「访问」对话框里勾选可见组织并保存。组织授权与单独 Key 授权按 OR 规则生效。

## 接口与边界

`server/integrations/tokensapi-organizations.js` 对接五个上游接口，每个只带它自己那一种凭证：

| 接口 | 凭证 | 用途 |
| --- | --- | --- |
| GET /api/current/organization | 客户的 API Key | 消费端按组织、按用户判定可见性 |
| GET /api/organizations/all | 服务端列表 Token | 后台「同步组织」 |
| GET /api/manage/users/search | 服务端列表 Token | 后台「用户」页添加用户时搜索；组织页指定可见成员时搜索本组织成员 |
| GET /api/user/self | 本人的访问令牌 | 控制台登录：这是谁 |
| GET /api/org/ | 本人的访问令牌 | 控制台登录：属于哪个组织、什么角色 |

个人 Key、身份 401/403、组织非启用状态不获得组织授权；网络、5xx、429、响应结构错误不作为成功或公开处理。消费端只使用数字 ID 和名称，忽略角色、成员信息、配额字段；`my_role` 只在控制台登录那一步读取。

请求禁止重定向，8 秒超时主动取消，最大响应 2 MiB。组织列表全量无分页，最多 10000 条，重复或非法 ID 拒绝整个同步。同步保留本地禁用状态及已有授权，不因上游缺少某项删除数据。

单独 Key 是市场本地独立授权，不会因为组织接口失败自动撤销；需要撤销时在插件配置中移除。这与已有 OR 策略保持一致。

## 用户授权依赖的两处 TokensAPI 接口

市场的「给单个用户授权插件」（对该用户名下所有 Key 生效）依赖下面两处，TokensAPI 已按此实现。
上游没有这两处时也不会出错：用户授权只是不命中，其余授权照常；后台「添加用户」退化为手填用户 ID。

**1. `GET /api/current/organization` 带上 Key 的所属用户**

在现有响应的 `data` 里加一个 `user` 字段（与 `organization` 并列）：

```json
{ "success": true, "data": {
  "organization": { "id": 7, "name": "Seven", "status": 1 },
  "user": { "id": 102, "username": "alice", "display_name": "Alice" } } }
```

- `id` 为正整数，`username` 非空；`display_name` 可为空，空时市场显示 `username`。
- 个人 Key 同样返回 `user`（`organization` 为 `null`）。
- 不返回 `user` 或为 `null`：该 Key 视为无所属用户，只是用户授权不命中。字段存在但结构不对会被当作上游错误。

**2. `GET /api/manage/users/search?keyword=&p=&page_size=`**

用与 `/api/organizations/all` 相同的服务端 Token（`MARKET_ORGANIZATIONS_TOKEN`，`Authorization: Bearer`）鉴权，
按用户名 / 邮箱 / 显示名模糊匹配，纯数字时也精确匹配用户 ID；`p` 从 1 开始，市场「用户」页每次取 `page_size=20`，搜索组织成员时取 `page_size=100`：

```json
{ "success": true, "data": { "page": 1, "page_size": 20, "total": 1,
  "items": [ { "id": 102, "username": "alice", "display_name": "Alice", "email": "…", "org_id": 0 } ] } }
```

- 每页最多 100 条，`total` 为匹配总数；市场只取 `id`、`username`、`display_name` 和 `org_id`，其余字段（邮箱等）直接丢弃、不落库。
- `org_id` 是用户所属组织（0 = 无组织）。组织页指定可见成员时只保留 `org_id` 等于本组织的用户；名单保存时再用用户 ID 查一次确认，存下用户 ID 和显示名。之后用户换了组织，名单里的行不再起作用（其 Key 解析出的组织已不是本组织）。
- 未配置或失败时市场后台显示「未配置 TokensAPI 用户搜索」，仍可手填用户 ID 添加。

## 组织管理员身份

市场把 **TokensAPI 组织当作租户**：组织号就是租户号，市场不自建用户体系；唯一记下的用户资料是被单独授权过的用户号和显示名。后台只有两种人，共用同一个登录端点与同一种会话 Cookie：

| 身份 | 凭证 | 能做什么 |
| --- | --- | --- |
| 平台管理员 | `MARKET_ADMIN_TOKEN` 后台口令 | 全部页面：插件、组织、Key、用户、操作记录 |
| 组织管理员 | 自己的 TokensAPI 用户 ID + 访问令牌 | 只有「我的组织」一页：在平台给本组织的插件里关掉不要的（只能收窄） |

**普通成员、没有组织的账号、组织未在市场登记或已停用的账号一律拒绝登录（401）**，并给出原因。后台没有只读席位：成员要看自己能装什么，直接用桌面端。

访问令牌由本人在 TokensAPI「个人设置 → 系统访问令牌」生成，用户 ID 在同一页；**市场不经手密码，也不接管任何登录界面**。上游校验令牌时要求数字用户 ID 随行（`New-Api-User` 头），所以这是一对凭证，缺一不可，与设备端 DshLogin 插件用的是同一对。

```
PUT /api/v1/session {tokensapi:true, userId, accessToken}   （同源 Origin 校验与失败限流）
  带这对凭证调上游两次（Authorization: <令牌> + New-Api-User: <用户 ID>）
    GET /api/user/self → {id, username, display_name}
    GET /api/org/      → {id, name, status, my_role}
    令牌无效 → 上游回 200 且 success:false（不是 401），按拒绝处理 → 401
    上游不可达 → 503，绝不放行
    my_role < 10，或组织未登记 / 已停用 → 401
    否则签发 __Host-market_session（7 天），会话行记下组织号与上游用户号
```

**谁是组织管理员由 TokensAPI 回答，市场不维护指派表。** 上游 `my_role >= 10`（`OrgRoleAdmin`，Owner 是 100）即是；在 TokensAPI 侧降权或移出组织，下次登录即被拒。

无论提交的是哪一种凭证，**任何一次失败都计入登录限流**：这个端点本身不需要身份，放过任何一类免费的失败，都等于送出一条猜后台口令、或拿廉价流量打 TokensAPI 的路子。

粘贴的访问令牌只在上面这两次上游调用中存在：**不落库、不缓存、不写日志**。会话行只冻结组织号与上游用户号，因此后台的每个请求都不再回调 TokensAPI；操作记录的操作者就是上游用户号（是标识不是凭据，可明文入库）。

停用组织会立刻让该组织所有管理员的会话失效；轮换 `MARKET_ADMIN_TOKEN` 会终止全部会话（含平台管理员自己）。市场会话独立于上游令牌：令牌事后作废不会中断已签发的市场会话（最长 7 天）。

## TokensAPI 调用市场

反方向的接口是同一套 `/api/v1`：TokensAPI 后端带 `Authorization: Bearer <后台口令>` 调用，身份等同平台管理员，常用的几步见 [接入速查](SERVICE-API.md#tokensapi-接入速查)，完整契约见 [管理 API](SERVICE-API.md)。市场不再签发单独的服务凭据。

两个方向的认证互不相通：上面的 `MARKET_ORGANIZATIONS_TOKEN` 是市场调 TokensAPI 用的，后台口令是 TokensAPI 调市场用的，不要互相复用。

## 上线验证

1. 部署前确认服务器 `.env` 里上述变量与既有 HMAC、加密 Secret 都在。
2. 运行 `npm --prefix market/server run verify`，构建并部署。
3. 用后台口令登录，在「组织」页点「同步组织」，核对实际组织 ID/名称。
4. 用明确绑定测试组织的有效 Key 在桌面端验证对应插件可见，其他组织及个人 Key 不获组织权限。
5. 用一个组织 Admin/Owner 的 TokensAPI 用户 ID 与访问令牌登录，确认只有「我的组织」一页；用普通成员账号、以及张冠李戴的 ID/令牌组合确认被拒；停用该组织后会话立即失效。
6. 用后台口令调 `GET /api/v1/plugins`（Bearer），确认可用；不带凭证返回 401。

本地模拟测试不代表生产网络联调成功；不要用假组织或假 Key 映射替代真实提供方。
