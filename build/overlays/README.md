# 产品覆盖（overlays）

对 staging 源码的领域改写模块：每个文件导出纯函数，由 `steps/` 里的
prepare-staging / configure-product 调度。子模块永远不动，改写只落在
`.build/` 生成目录。

## 目录

```text
overlays/
├─ branding.mjs          品牌：锚点校验、主进程改写（含旧用户数据迁移）、
│                        Logo 替换、补丁层品牌
├─ updates.mjs           更新：停用上游更新、更新菜单验收、更新插件产品配置
├─ market/               插件市场相关覆盖与测试
│  ├─ market-source.mjs  来源、fake-IP、界面、安装更新与上游测试适配
│  ├─ market-auth.mjs    产品市场 API Key 透传与目录缓存隔离
│  ├─ market-auth.test.mjs        透传安全边界与覆盖锚点测试
│  └─ market-installed-ui.mjs     已安装插件与系统组件分组展示
├─ windows-acl.mjs       Windows ACL 启动链：宿主控制台注入、基础设施熔断
├─ windows-installer.mjs Windows 安装器：升级保护 nsh、NSIS 资源固定
└─ desktop-runtime.mjs   桌面运行时：向导跳过、市场固定、stderr 保护等
```

## 约定

1. **覆盖进本目录，入口只调度。** 新增产品覆盖时在对应主题文件或目录里写
   导出函数，再到 steps/prepare-staging.mjs 或 steps/configure-product.mjs
   的对应分节调用；没有合适主题时新建文件并在本 README 登记。
2. **每个覆盖自带锚点守护。** 上游代码变动导致锚点失配时装配立即失败等待
   人工复查，绝不静默漏掉覆盖。
3. **锚点匹配前归一化 CRLF。** Windows CI 的 git autocrlf 会把检出内容转成
   CRLF，LF 写死的锚点会整体失配（v0.3.14 首次构建的事故）。
4. **prepare 与 configure 的分工**：prepare-staging 在 `yarn install` 之前跑，
   管源码级覆盖与插件注入；configure-product 在打包前跑，管品牌文案、Logo
   与 electron-builder 参数。同一主题的两个阶段函数放同一个 overlay 文件。
