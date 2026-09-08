# 插件市场 Key 授权管理

> 当前管理页面已升级为按组织配置，参见 `docs/market-org-visibility.md`。本文的逐 Key 操作流程为兼容旧数据保留；新页面不再提供逐 Key 编辑。旧受限插件保持原策略，管理员保存组织配置后才切换，旧接口不能覆盖已迁移插件。

入口为 `/admin/`。原 `/admin/access.html` 自动跳转到同一管理页。直接在每个插件右侧填写 API Key（每行一个）并保存；不配置 Key 表示所有人可见。已保存 Key 以指纹显示，可移除；移除全部 Key 并留空保存即恢复公开。保存操作只替换当前插件的权限，不影响其他插件。原客户备注、停用和到期设置折叠在高级管理中；已停用或到期的旧 Key 不会因重新添加而自动启用。管理员凭证只保留在页面内存，不进入 localStorage。

客户授权使用 HMAC-SHA256(API Key, 服务端密钥) 作为索引，D1 不保存明文 Key。这里的企业备注由管理员录入，并非从 New API 自动查询。授权状态以本市场为准，当前不自动同步 New API 的 Key 禁用、额度与到期状态；撤销客户访问请在市场后台停用该授权。

## Cloudflare 配置

为 `tokenscowork-market` Pages 的生产环境配置：

- D1 绑定 `MARKET_DB`，执行 `market/scripts/schema.sql` 初始化。
- Secret `MARKET_ADMIN_TOKEN`：独立随机管理员凭证，建议至少 32 字节随机值。
- Secret `MARKET_HMAC_SECRET`：独立随机指纹密钥，建议至少 32 字节随机值；更换它会使现有 Key 绑定失效，需要重新录入。
- 环境变量 `MARKET_ACCESS_REQUIRED=true`：授权存储或密钥缺失时拒绝请求，避免配置丢失时回退到公开静态目录。
- 可选私有 R2 绑定 `MARKET_PACKAGES`，关闭桶的公开访问和公开自定义域名。安装包由运维上传，后台填写对象名。

先创建数据库并应用 schema，配置两个 Secret 和生产绑定，再部署。不要将凭证写进仓库或 URL。初始化命令示例：

```powershell
npx wrangler d1 create tokenscowork-market-access
npx wrangler d1 execute tokenscowork-market-access --remote --file market/scripts/schema.sql
```

在 Pages 设置中绑定上述 D1/R2 和密钥。当前仓库不包含这些部署凭据与数据库 ID。

2026-09-08 已为生产项目完成 D1 初始化、两个 Secret 与必需授权变量配置，并部署后台。管理员凭证通过当前 Windows 用户的 DPAPI 加密保存在忽略目录 `.build/market-admin.credential.xml`；运行 `market/scripts/copy-admin-token.ps1` 可复制到剪贴板登录。该文件无法由另一台机器或其他 Windows 用户解密，删除前应另行妥善保管管理员凭证。R2 私有包存储尚未配置，当前没有上传任何私有安装包。

## 接口

管理员接口使用 `Authorization: Bearer <MARKET_ADMIN_TOKEN>`：

- `GET /api/admin/access`：授权与插件配置列表，仅返回指纹。
- `PUT /api/admin/keys`：`{apiKey 或 fingerprint, label, enabled, expiresAt, plugins: [插件ID]}`；到期时间为毫秒时间戳或 null。一次提交原子替换该 Key 的权限。
- `PUT /api/admin/plugins`：`{id, visibility: public或restricted, metadata, objectKey}`，metadata 使用 roster 条目结构。
- `PUT /api/admin/plugin-keys`：`{id, metadata, objectKey, apiKeys: [新增明文Key], keepFingerprints: [保留的已有指纹]}`；原子替换当前插件授权，列表为空自动公开，否则自动限制。新 Key 仅保存 HMAC 指纹。

客户端使用 `Authorization: Bearer <客户API Key>`：

- `GET /v1/plugins` 和 `/roster.json`：公开插件与当前 Key 获授权插件。没有授权的 Key 仅看到公开插件。
- `GET /downloads/<插件ID>`：每次重新检查权限并读取私有 R2 对象，不返回公开下载链接。

启用数据库后，目录和下载禁止共享缓存，数据库故障返回 503，不能使用静态目录绕过授权。已下载文件无法远程收回。已公开的 npm/GitHub 包不能靠本市场权限变成私有包，后台会明确提示。

## 桌面接入边界

当前已发布 Desktop 的标准市场源请求不携带客户 API Key，因此仍只显示公开目录。产品构建层现已加入 `build/overlays/market/overlay-market-auth.mjs`：通过可选的统一 credentials 服务读取 `TOKENSAPI_API_KEY`，仅向产品市场 HTTPS origin 的目录接口发送 Bearer Header；不依赖模型插件，不向 npm/GitHub、管理接口或跨域重定向目标透传。无 Key 时正常读取公开目录。下次请求检测到 Key 变化时清理内存目录和游标，不使用未分用户的磁盘目录兜底。需要后续构建并安装新版才能使用；本次未打包发布。后台撤销权限后，已打开目录需刷新才能更新。

上游标准安装契约只支持 npm/GitHub；它不会自动安装 `/downloads/<id>` 的 R2 包。私有包自动安装仍需对应安装适配器，包含完整性、许可证与重启/更新流程校验。当前受保护下载接口可供携带凭证的客户端下载文件，不能宣称现有 Desktop 已完成私有安装闭环。

## 验证

`node --test market/tests/access.test.mjs` 使用真实内存 SQLite 验证鉴权、跨 Key 隔离、撤销、到期、失败关闭与指纹存储。`node build/verify/verify-market-catalog.mjs` 验证原有公开名册不漂移。

市场维护工具和数据库初始化文件放在 `market/scripts/`，后台测试放在 `market/tests/`。桌面市场覆盖统一放在 `build/overlays/market/`：`overlay-market-source.mjs` 管理来源与界面，`overlay-market-auth.mjs` 和 `overlay-market-auth.test.mjs` 负责透传及测试，不属于后台工具。Worker 拒绝对外读取市场脚本和测试目录。
