# 平台覆盖（platform）

负责网页抓取的系统代理回退、Windows ACL 启动链与安装器，以及打包身份和 macOS 单架构签名、公证。
资源和签名回调由登记表的 copy 条目复制进 staging；源码子模块保持只读。

## 文件职责

| 文件 | 负责什么 |
| --- | --- |
| [overlays.mjs](overlays.mjs) | 登记表：14 条覆盖的阶段、目标文件、原因与删除条件 |
| [system-proxy-overlay.mjs](system-proxy-overlay.mjs) | 主进程 / supervisor / Host 的系统代理查询桥，以及已安装 web-fetch 无路由时的按 URL 回退 |
| [windows-acl-overlay.mjs](windows-acl-overlay.mjs) | 以产品无窗口控制台替换上游 AllocConsole，给 executeArgv 装基础设施失败熔断 |
| [windows-installer-overlay.mjs](windows-installer-overlay.mjs) | 写入升级保护脚本、固定 NSIS Unicode 资源，拒绝卸载时删除用户数据 |
| [desktop-packaging-overlay.mjs](desktop-packaging-overlay.mjs) | 打包身份、Windows x64 裁剪、macOS 单架构发布 / 校验 / entitlement、fs-ext 架构 |
| [mac-adhoc-sign.ts](mac-adhoc-sign.ts) | 无正式凭据时替换上游 afterPack，执行 ad-hoc 签名 |
| [mac-notarization.mjs](mac-notarization.mjs) | afterSign 公证：保存签名应用、摘要和提交编号；恢复工作流复用 |
| [mac-signing-resolve.mjs](mac-signing-resolve.mjs) | 按凭据完整性选择正式签名或 ad-hoc，部分配置直接报错 |
| [staging-windows-acl-smoke.mjs](staging-windows-acl-smoke.mjs) | 手动诊断：构建后用真实 Electron 验证 ACL runner 与上游一致 |
| `assets/windows/` | 复制进 staging 的 TypeScript / NSIS 源文件，保留目标工具要求的格式 |
| `*.test.mjs` | 外层覆盖回归 |
| [review.json](review.json) | pin 基线与验证证据 |

## 执行顺序

1. `staging-prepare.mjs`：系统代理桥、复制 ad-hoc 签名回调与 ACL 资源、fs-ext 架构、ACL 控制台与熔断。
2. `staging-runtime-patch.mjs`：已安装 web-fetch 的系统代理回退。
3. `staging-product-configure.mjs`：打包身份、安装器保护、macOS 单架构发布与校验、复制公证回调。
4. `build/pipeline/macos-build.mjs` 与发布工作流按 `mac-signing-resolve.mjs` 选择签名模式。

## 验证命令

| 命令 | 检查什么 |
| --- | --- |
| `yarn test:build platform` | 覆盖代码、签名模式、公证状态 / 恢复、安装器保护 |
| `yarn test:uninstall` | Windows 卸载脚本 |
| `yarn product:overlays platform --check` | 记录完整性与关联 pin |

macOS 签名、公证、安装和 Windows 安装 / 卸载只能在对应 runner 或真机上验收；公证恢复流程见[构建说明](../../README.md)。
