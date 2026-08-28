# 插件市场组织可见域设计（基础版）

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

产品打包目前隐藏了市场「添加标准来源」按钮（`build/assembly/overlays/
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
4. 恢复市场「添加来源」按钮（改 overlays/market.mjs，随下个产品发版生效）
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
