# 插件市场回归记录（2026-09-11）

> 历史排障记录：以下结论仅针对当时测试状态，不代表当前版本。保留复现步骤和证据供后续回归参考；本地临时证据路径可能已失效。

## 验收结论

**尚不能将整个插件市场判定为无已知问题或发布验收通过。**

本轮是诊断和回归：新增测试，没有调整生产权限、发布包、部署服务或提交代码。
保留了原有未提交的路由修补，以及其他任务正在进行的 0.5.0 升级改动。

测试对象是本轮开始时 `.build/desktop/dsh-community-market` 中已经装配的市场代码，
包括未提交的共享路由修补。测试期间 VERSION 从 0.4.13 变成了 0.5.0，
Desktop 子模块和装配流程也被其他工作改动，因此本报告不能替代新的 0.5.0 产物验收。

## 已确认的问题

1. **已复现卸载丢失市场路由（阻断验收）。** 安装/更新附带 Registry 参数，
   `MarketInstallService.executeUninstall` 却直接调用 `runPnpm(['remove', intent.packageName], …)`。
   在冷缓存、多插件 Profile 中，pnpm 移除一个包时会重新解析其他仍安装着的包，
   然后错误访问公开 npm。卸载渐进式工具时查询浏览器操作返回 `ERR_PNPM_FETCH_404`；
   后续 5 个卸载操作均未通过，错误交替指向已从公开 npm 移走的浏览器操作、渐进式工具、插件体检。
   其中一次伴随 Windows/Node 的 `UV_HANDLE_CLOSING` 断言退出，不能直接归为同一个代码根因。
   需要统一安装、更新、卸载的 Profile Registry 上下文，不能只给 `add` 加参数。
   **对照实验通过：** 在同一失败的临时 Profile 中，只给包管理器调用补入
   `--config.registry=https://registry.npmjs.org/` 和
   `--config.@tokensapi:registry=https://market.tokensapi.ai/registry/by-package/`，
   通过原 `MarketInstallService` 重放卸载后成功，其他依赖保持不变。
   注意 pnpm 11 的 `remove` 不接受普通 `--registry`，需要它支持的配置参数形式。
   这是测试用 runner 的对照注入，**没有修改生产安装服务，所以缺陷仍待修复**。

2. **Agent 命令安装和桌面市场不是同一入口。** 原生 `dsh plugin --profile … add …`
   只是把参数转给 pnpm，不会自动查询 TokensCowork 市场、识别包的 Registry 或取得客户 Key。
   用独立缓存、明确指定公共 npm 后，`@tokensapi/dsh-plugin-check@0.4.0` 复现
   `ERR_PNPM_FETCH_404`；同一个 CLI 加入 `@tokensapi` 共享市场 Registry 参数后安装和卸载通过。
   公共 npm 元数据 HTTP 实测为 404。已有缓存会掩盖错误，所以“这台机器以前装过能成功”不能作为验收。
   尚未收到用户所述 Agent 的原始报错/命令，不能断言它一定就是这一次复现。

3. **共享路由修补存在部署闭环缺口。** `market/server/private-registry/routes.js`
   原始文件不包含 `/registry/by-package/`，通过 `build/modules/market/market-routing-prepare.mjs`
   生成的额外 staging 才有。现有 `market/server/docker-compose.yml` 构建 context 是当前目录，
   原部署文档仍指导在该目录直接 `docker compose up -d --build`，这样会漏掉补丁。
   当前线上接口通过不代表下次普通重建也能通过。CI 的 market workflow 只部署旧域名代理，
   也没有替服务器部署这个补丁。

4. **已发布安装包与本地修补不一致。** v0.4.13 构建运行 `34577181949` 成功，
   commit 为 `cea02a3d5d5d64e063b6b18e8cc960803e08b6f9`，但本地共享路由文件和接入修改尚未提交，
   不在这个安装包里。服务端更新本身不能替换已安装客户端的 pnpm 参数。

5. **国内首装仍依赖公开 npm。** 自有插件经市场下载，第三方依赖仍走
   `https://registry.npmjs.org/`。冷缓存、单请求 45 秒、无重试的压力条件下，
   连接中心出现依赖下载超时；另一次旧/新域名只读下载探测出现 `fetch failed`。
   这不是已证实的路由 403，也不等同于默认重试配置必然失败，但不能宣称国内下载问题已经全部解决。

## 已完成的回归

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 后台、组织/Key 权限、目录生命周期、Registry、旧域名代理、overlay | 159 通过 | 包括新增真实 SQLite 共享路由测试 |
| 已装配桌面市场 | 272 通过，9 跳过 | 24 个测试文件；并行首次运行有 worker 超时，单 worker 重跑通过 |
| TypeScript | 通过 | 已装配市场代码，不代表正在升级的所有 Desktop 代码 |
| 在线公开链路（已有全局缓存） | 22 通过 | 当时匿名可见的 6 个插件，新旧域名元数据和压缩包 SHA1、同配置连续安装、更新检查、逐个卸载 |
| Agent 原生 CLI，独立缓存 | 3 个断言通过 | 包含公共 npm **预期失败**的复现，并不代表裸命令已经支持私有市场 |
| 受限下载实装 | 通过 | 本地真实市场处理器 + SQLite + 真实 pnpm + 有效插件压缩包；元数据/压缩包均携带客户测试 Key，撤权后 HTTP 403 |
| 冷缓存全链路和真实旧版升级 | **15 通过，7 失败** | 5 个卸载路由错误、1 次连接中心下载超时、1 次钉盘归档元数据/压缩包网络探测失败；真实 0.1.0 → 0.4.0 更新通过，其他包与 bundle 登记保留 |
| 失败卸载的路由对照重放 | 通过 | 仅在测试 runner 中补回共享 Registry 配置，原失败操作成功，其他依赖保留；不是生产修复 |

受限下载测试只用本地虚构 Key；它没有发送到线上。线上现有测试 Key 返回的目录没有额外的受限插件，
所以没有冒充已完成“正式组织账号授权下载”的验收，也没有为测试更改线上权限。

### 证据

- 已有缓存在线链路：`C:/Users/wzm/AppData/Local/Temp/cowork-market-regression-iQdDnb/results.json`
- 冷缓存 CLI：`C:/Users/wzm/AppData/Local/Temp/cowork-agent-cli-qBLVWN/results.json`
- 受限 pnpm 下载：`C:/Users/wzm/AppData/Local/Temp/cowork-private-regression-VNhp7R/results.json`
- 冷缓存全链路：`C:/Users/wzm/AppData/Local/Temp/cowork-market-regression-5Z7EEb/results.json`

### 可重复运行

仓库根目录：

```powershell
node --test build/modules/market/*.test.mjs market/server/tests/*.test.mjs market/server/private-registry/*.test.mjs market/registry/scripts/*.test.mjs
```

已装配 `dsh-community-market` 目录：

```powershell
corepack yarn test --maxWorkers=1
corepack yarn typecheck
```

已装配 `dsh-plugin-desktop` 目录（要求旁边的市场 `lib/install/service.js` 已编译）：

```powershell
corepack yarn node ../../../build/modules/market/market-live-regression.mjs
corepack yarn node ../../../build/modules/market/market-agent-cli-regression.mjs
corepack yarn node ../../../build/modules/market/market-private-install-regression.mjs
```

这些测试创建独立临时目录，不修改用户 Profile、不发布 npm 包、不变更生产 ACL。
测试目录会保留用于排障；其中不保存真实 API Key。真实安装只验证包传输、版本和 Profile bundle 登记，
不会运行插件、不调用模型，也不验证插件自身功能。

## 发布前必须补齐

1. 修复卸载丢失 Registry 上下文，覆盖同 Profile 多插件、冷缓存、不同源和不同 scope；给 Agent 一个明确、受控、能复用市场鉴权与安装服务的入口，不要要求模型猜 Registry URL 或手工拼 Key。
2. 将后端共享路由接入唯一可重复的正式构建/部署流程，并测试原部署命令不会漏掉它。
3. 在当前升级工作稳定之后，重新装配并复测；版本号相同不代表装配内容相同。
4. 用真正拥有受限插件授权的测试 Key/组织做线上验收，覆盖授予、撤销和跨组织拒绝。
5. 用最终安装包做 UI 下载、安装、重启加载、更新和卸载验收。
6. 评估第三方依赖的国内代理/缓存与默认重试策略，不能只加速插件本体。

测试可以限定范围发现和降低风险，不能承诺任意网络、任意包、任意版本下永远零错误。
