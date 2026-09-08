# 产品覆盖（overlays）

对 staging 源码的领域改写模块：每个文件导出纯函数，由 `steps/` 里的
prepare-staging / configure-product 调度。子模块永远不动，改写只落在
`.build/` 生成目录。

## 目录

```text
overlays/
├─ branding-overlay.mjs          品牌：锚点校验、主进程改写（含旧用户数据迁移）、
│                        Logo 替换、补丁层品牌
├─ updates-overlay.mjs           更新：停用上游更新、更新菜单验收、更新插件产品配置
├─ market/               插件市场相关覆盖与测试
│  ├─ market-source-overlay.mjs  来源、fake-IP、界面与上游测试适配（保留旧更新实现）
│  ├─ market-auth-overlay.mjs    产品市场 API Key 透传与目录缓存隔离
│  ├─ market-auth-overlay.test.mjs        透传安全边界与覆盖锚点测试
│  ├─ market-installed-ui-overlay.mjs     已安装插件与系统组件分组展示
│  ├─ market-dialog-position-overlay.mjs  去掉主题对原生弹窗定位的全局覆盖
│  ├─ market-update-overlay.mjs           npm 插件检查更新、确认、执行与界面覆盖
│  ├─ market-update-overlay.test.mjs      覆盖组合与实际装配入口守护
│  └─ market-update.spec.ts               注入 staging 的插件更新行为测试
├─ windows-acl-overlay.mjs       Windows ACL 启动链：宿主控制台注入、基础设施熔断
├─ windows-installer-overlay.mjs Windows 安装器：升级保护 nsh、NSIS 资源固定
└─ desktop-runtime-overlay.mjs   桌面运行时：向导跳过、市场固定、stderr 保护等
```

## 约定

1. **覆盖进本目录，入口只调度。** 新增产品覆盖时在对应主题文件或目录里写
   导出函数，再到 steps/staging-prepare.mjs 或 steps/staging-product-configure.mjs
   的对应分节调用；没有合适主题时新建文件并在本 README 登记。
2. **每个覆盖自带锚点守护。** 上游代码变动导致锚点失配时装配立即失败等待
   人工复查，绝不静默漏掉覆盖。
3. **锚点匹配前归一化 CRLF。** Windows CI 的 git autocrlf 会把检出内容转成
   CRLF，LF 写死的锚点会整体失配（v0.3.14 首次构建的事故）。
4. **prepare 与 configure 的分工**：prepare-staging 在 `yarn install` 之前跑，
   管源码级覆盖与插件注入；configure-product 在打包前跑，管品牌文案、Logo
   与 electron-builder 参数。同一主题的两个阶段函数放同一个 overlay 文件。

## 插件手动更新

进入市场「已安装」时检查更新，也可点击「检查更新」重试。对当前授权目录中
可管理的 npm 插件，从 Profile 的实际安装包读取版本，与 npm `latest` 正式版
做语义版本比较；有新版才显示更新按钮。Git/file/workspace 插件、系统组件不
独立更新，无法检查时明确提示失败或不可更新，不当成已是最新版。

更新需二次确认，Host 绑定精确版本和 Profile，执行前重新查询授权目录、检查
插件可变性与本地版本；复用上游 pnpm 执行及重启凭证，不先卸载、不改写插件
设置或启用状态。包管理器失败不承诺自动回滚，保留上游 Recovery 恢复提示。
公开 npm 包仍可绕过市场直接下载；市场权限不是包内容的保密措施。

验证（不打安装包）：

```powershell
node --test build/overlays/market/market-update-overlay.test.mjs
# 只重装配市场相关副本，不重建整棵 staging；要求已有 staging 和依赖。
node build/overlays/market/market-update-overlay.test.mjs --stage
Set-Location .build/desktop
corepack yarn workspace dsh-community-market typecheck
corepack yarn workspace dsh-community-market test
```
