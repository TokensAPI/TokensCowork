# 上游升级检查指南

适用范围：升级 Desktop、DSH 或内置插件，并保持 TokensCowork 的产品行为。先判断变化，再改固定版本；不要把“拉到最新”当成兼容性验证。

## 1. 先确认这次升级了什么

以 `product.json` 为产品输入清单，记录旧、新两组：Desktop commit、DSH commit / npm runtimeVersion、插件 commit / version / 产物 SHA256。产品版本由 `VERSION` 驱动，不等于 Desktop 或 DSH 的版本。

- 先读上游 Release、提交差异和破坏性变更；特别看 Desktop 自带的 DSH 版本和 Yarn patches。
- Desktop 源码 pin、嵌套 DSH 源码 pin、实际安装的 npm 运行时是三件事。可以显式覆盖 Desktop 推荐的 DSH，但必须验证组合，不是“两个都最新就兼容”。
- 核对 Node、Electron、Yarn、原生依赖最低版本；`verified` / 签名只证明提交身份，不证明我们的插件组合可用。
- 子模块按 Git commit 固定；产物插件还要核对 URL、版本和 SHA256，不能只更新子模块指针。
- 不覆盖协作者的未提交开发；产品加工只进独立 `.build/desktop-*`，不修改只读子模块。提交产品前核对 gitlink 与清单，不为绕过报错关闭校验。

## 2. 按模块复查覆盖

先运行 `corepack yarn product:overlays --check`。每个 `build/modules/<模块>/review.json` 是覆盖明细的唯一台账：查看 `targets`、`appliedBy`、`verification`、`retireWhen`，不要只看文件名。

| 模块 | 升级时重点看 | 必须验证的产品行为 |
| --- | --- | --- |
| branding | 产品身份、原生窗口、已编译客户端标题、Logo 入口、预设提示词、旧数据迁移 | 初始页和会话标题、兼容模式标题、托盘/安装器图标正确；旧数据可迁移，新用户不继承旧配置 |
| market | 来源配置持久化、目录鉴权/缓存、Registry 安装与更新接口、主题 Modal CSS | 只显示产品来源；误删后自愈；换 Key 不串目录；跨域不泄漏 Key；安装/更新保留启用状态；弹窗定位正确 |
| runtime | DSH 依赖/peer/patch、Cordis 作用域、插件接口、预设发现、压缩与事件持久化 | 登录/RPC 可用；插件可加载及卸载；`/` 菜单正常；压缩有效且失败不损坏历史；打入 asar 后预设仍可发现 |
| updates | 产品 Release 来源、官方入口开关、菜单与发行类型 | 纯净/带插件两种装配只出现对应入口；稳定/预发布服从 GitHub 状态；下载正确架构；失败后可重试 |
| platform | Windows ACL / 控制台 / NSIS，macOS 架构 / 签名 / afterPack | Windows 无连续闪窗、工作区边界有效、占用升级可恢复、卸载默认保留数据；Mac 原生模块、启动、签名及 Keychain 行为正确 |

边界不要混淆：`market` 更新的是插件，`updates` 更新的是桌面应用；`runtime` 管加载和协议兼容，`platform` 管操作系统与安装包。市场服务部署覆盖是独立路径，Desktop 出包不会自动部署服务。

## 3. 这次升级暴露的重点风险

下列项目以 0.5.0 验证为例；以后以对应 `review.json` 的最新证据为准。

- **RPC 作用域**：Cordis getter / service tracker 改动会让注册方丢失 `webServer`。不仅测试启动，还要测 Host/鉴权限制、显式注销和插件卸载后的路由清理。
- **压缩契约**：模型曾返回 `ACK` / `STORED` / 拒绝文本，被原生非空检查接受。复查摘要任务隔离、八段格式、图片/工具历史、输出截断和错误；无效摘要必须保留历史。至少连续压缩三次再回忆事实。原文太短、摘要不更小时拒绝是正常保护。
- **已加工的开发缓存**：装配会保留 `node_modules`，所以不仅要测新安装，还要测上一版覆盖迁移和连续执行两次。修改压缩 helper 时登记已知旧版本的签名并补迁移回归；只认标记但要求代码等于最新版，会把正常旧缓存误判为损坏。未知修改仍应报错，不能靠跳过校验或删除用户数据解决。
- **模型协议与多模态**：不要假定升级已自动切成 Responses，也不要只凭模型名字判断视觉支持。核对实际请求路径、能力元数据、token 上限、流式结束原因；分别测文本直连、原生视觉、Modlens 桥接以及压缩时的路由。不通过修改全局模型或压缩阈值掩盖问题。
- **插件接口**：联网搜索旧版 `description` 是字符串，新 DSH 要求 `description()`，一个插件就可能破坏整个 `/` 候选列表。检查真实运行产物和固定插件组合，peer 版本对齐不能替代行为测试。
- **预设与 asar**：当前解析修复由 Desktop Yarn patch 接管，我们只验证，不再重复补丁。确认新版本仍带等效处理；开发目录能启动不能证明打包后能启动。
- **已发布客户端品牌**：`DSH_CLIENT_TITLE` 可能早已在 npm 产物中替换成常量。外层设置环境变量不一定有效；要测初始 HTML、登录后页面和会话标题三处。
- **安装元数据与操作文案**：Windows 快捷方式悬停说明来自 Desktop `package.json.description`，不是窗口标题；旧快捷方式需新包覆盖安装后验收。另查市场安装/卸载/更新/重启的中英文提示，以及原生终端、加载失败和目录选择报错。检查编译产物，不只检查源码；保留依赖标识、许可证及旧安装识别名称。
- **上游云服务入口**：产品隐藏 Agents Anywhere 的侧边栏“手机连接”注册，保留原组件及已有连接配置。升级 Desktop 内带的 AA 产物时复查该注册，避免入口重新出现；不要将隐藏入口误认为禁用了后台服务。
- **网页抓取系统代理**：产品通过 Electron 按 URL 解析系统代理，再由 HostRpc 传给隔离 Host 的 web-fetch；显式环境代理优先，DIRECT/NO_PROXY 仍走原安全校验。升级需同时复查主进程、Host 入口和已安装 web-fetch-http 产物，测试 Fake-IP、取消、代理失败与内网拒绝。仅支持首选 HTTP/HTTPS 路由，SOCKS 与备用路由尚不支持；Windows 实测不能代替 macOS 验收。
- **用户数据与插件残留**：纯净 Profile 测试之外，还要用备份副本测旧 Profile、旧用户插件、禁用插件和 Safe Mode。内置插件变更不等于自动清理用户自行安装的版本；不要删除真实用户配置来“证明兼容”。
- **发行类型**：带插件版本也可以是 `x.y.0`。新发布的 clean/bundled 标记从固定 `product.json` 自动生成；不要靠版本尾号判断。它与 stable/prerelease 是两个维度。

## 4. 最小执行顺序

1. **比较与固定输入**：完成差异审查，再同步 `product.json`、对应 gitlink 和必要产物校验值。Desktop 内嵌 DSH 与产品覆盖不同的情况要明确记录。
2. **覆盖决策**：逐项选择保留、适配或退役。pin 改变只提示复查；锚点匹配只说明找到了位置，都不等于功能正确。
3. **依赖变了才刷新锁**：启用/禁用插件、runtime/peer/patch 改变时，运行 `corepack yarn product:refresh-lock`，审查 `build/pipeline/product.yarn.lock` 差异。它是独立维护步骤，不要每次出包都跑；机器资源不足时用受控构建环境生成并取回锁文件。正式构建仍必须 immutable 安装及许可证验证。
4. **本地定向回归**：先跑外层测试、覆盖记录要求的实际运行时测试，再复用 staging 做 Electron 功能验收。需要检查构建逻辑时才跑完整 `product:check-desktop`；它会重新装配和编译，不是轻量启动命令。
5. **CI 平台验收**：代码提交推送后由 GitHub 构建 Windows amd64、macOS arm64 / amd64。无需本机再生产一次 Windows 安装包；不过 CI 只能验证已提交的输入，不能验证本机未提交修复。
6. **安装与升级**：测试新安装、旧版覆盖升级、卸载后重装、占用文件失败恢复。Mac 两种架构要原生验证；Windows 上的 Mac 脚本单元测试不能代替真机。
7. **记录再发布**：证据写入本次 `docs/releases/vX.Y.Z.md`，覆盖台账只更新已复核的基线。记录命令、通过/跳过数量、实测模型和平台、失败重试及剩余缺口，不写“保证无问题”。

常用命令（仓库根目录）：

```powershell
corepack yarn product:overlays --check
corepack yarn test:build
corepack yarn test:uninstall
corepack yarn test:release-notes
node --test scripts/generate-plugin-manifest.test.mjs
corepack yarn product:check
powershell -File scripts/dev-desktop.ps1 -Sandbox -StageName desktop-v050
```

最后一条的 staging 名按待测版本替换；脚本会按输入变化装配/编译，**不是每次启动都打包**。`product:check` 核对清单与 Git 索引里的 gitlink；未同步 gitlink 时失败属于发布准备未完成，不是 Electron 功能故障。不能用临时放宽校验来发布。

真实模型验证只用已授权凭据、隔离 Profile 和合成案例，不输出 Key、不发送用户历史。自动压缩至少覆盖压力触发和上下文溢出恢复；用测试容量模拟时必须注明，不能写成已跑到产品默认长上下文阈值。

## 5. 什么时候能删除覆盖

先在独立 staging 停用**这一项**覆盖，让原生上游通过相同失败案例及相同回归，再确认实际安装包中的行为。满足后删除实现、调用和失效台账，保留必要行为测试并记录由哪个上游提交接管。

- 产品定制（品牌、产品市场）不因上游升级就删除；优先迁移到上游公开配置接口。
- 临时修复不能只因版本更高就删除，也不能只换锚点让测试变绿。
- `upstream` 表示上游已接管，不代表还有自有补丁；`inactive` 表示没有调用，不要当成当前产品能力。
- 适配成功夹具与新的明确契约可以，但不能删除失败断言、跳过坏案例或把未经修改的上游测试说成原样全过。

## 6. 发布前最后确认

`VERSION`、两份产品清单、标签和发布说明一致；插件生产依赖许可证通过；所有平台成功才发布。当前 Build Desktop 由 `v*` 标签推送或手动触发，普通 master 推送不触发它；默认发布为 pre-release，稳定版须明确选择。下载页和插件市场有各自的部署工作流，不能把它们当成重复打桌面包。

本地回归通过 ≠ 平台安装完成 ≠ 已发布。发布前备份用户数据；上游变更了会话格式时，不假定旧版本还能读取新格式，回退应用和恢复数据应分别计划。

相关入口：[构建流程](../build/README.md) · [覆盖台账说明](../build/modules/README.md) · [发布操作](manual-release.md) · [0.5.0 验证记录](releases/v0.5.0.md)
