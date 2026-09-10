# TokensAPI 组织集成

## 服务端配置

- `MARKET_ORGANIZATIONS_BASE_URL`：生产使用 `https://tokensapi.ai`，测试使用 `https://dev.tokensapi.ai`，不跨环境自动回退。
- `MARKET_ORGANIZATIONS_TOKEN`：组织列表专用固定 Token，使用 Cloudflare Pages Secret 配置；不写入代码、前端或提交记录，不复用后台登录密码。

配置完成后部署市场 Worker。后台显示组织身份已接入，管理员点击“同步组织”，再为可选插件勾选可见组织并保存。原有组织授权与单独 Key 授权继续按 OR 规则生效。

## 接口与边界

`server/integrations/tokensapi-organizations.js` 对接 GET /api/current/organization 和 GET /api/organizations/all。前者只传客户的 API Key，后者只传服务端列表 Token。

个人 Key、身份 401/403、组织非启用状态不获得组织授权；网络、5xx、429、响应结构错误不作为成功或公开处理。仅使用数字 ID 和名称，忽略角色、成员信息、配额字段。

请求禁止重定向，8 秒超时主动取消，最大响应 2 MiB。组织列表全量无分页，最多 10000 条，重复或非法 ID 拒绝整个同步。同步保留本地禁用状态及已有授权，不因上游缺少某项删除数据。

单独 Key 是市场本地独立授权，不会因为组织接口失败自动撤销；需要撤销时在插件配置中移除。这与已有 OR 策略保持一致。

## 上线验证

1. 在生产 Pages 项目配置上述变量和 Secret，保留既有 HMAC、加密与会话配置。
2. 运行 `npm --prefix market/server run verify`，构建并部署。
3. 登录后台，点击“同步组织”，核对实际组织 ID/名称。
4. 用明确绑定测试组织的有效 Key 验证对应插件可见，其他组织及个人 Key 不获组织权限。

本地模拟测试不代表生产网络联调成功；不要用假组织或假 Key 映射替代真实提供方。
