# 产品装配（assembly）

把只读的 Desktop 子模块加工成 TokensCowork 产品的全部装配逻辑。所有改写只发生在
生成目录 `.build/desktop/`，子模块永远不动。

## 目录

```text
assembly/
├─ prepare.mjs        装依赖前的装配：重建 staging、注入插件与源码覆盖
├─ configure.mjs      打包前的配置：品牌、Logo、安装器与 electron-builder 参数
├─ refresh-lock.mjs   默认插件或生产依赖变化后重新生成 build/product.yarn.lock
├─ overlays/          产品覆盖，按主题一个文件；两个入口只做调度
│  ├─ branding.mjs           品牌：锚点校验、主进程改写（含旧用户数据迁移）、
│  │                         Logo 替换、补丁层品牌（UI 品牌停用 + 系统提示词身份）
│  ├─ updates.mjs            更新：停用上游更新、更新菜单验收、更新插件产品配置
│  ├─ market.mjs             插件市场：fake-IP 豁免、预置产品源、隐藏上游合作源
│  │                         与添加/删除入口、上游测试适配
│  ├─ windows-acl.mjs        Windows ACL 启动链：宿主控制台注入、基础设施熔断
│  ├─ windows-installer.mjs  Windows 安装器：升级保护 nsh、NSIS 资源固定
│  └─ desktop-runtime.mjs    桌面运行时：持久 profile 修复、stderr 保护
└─ assets/            装配期复制进 staging 的产品资产
   ├─ brand/                 Logo 与客户端品牌组件
   └─ windows/
      ├─ acl/                ACL 宿主控制台与熔断的源码及测试
      └─ installer/          NSIS 覆盖升级保护脚本
```

## 约定

1. **覆盖进 overlays/，入口只调度。** 新增产品覆盖时在对应主题文件里写导出函数，
   再到 prepare.mjs / configure.mjs 的对应分节调用；没有合适主题时新建文件并在
   本 README 登记。
2. **每个覆盖自带锚点守护。** 上游代码变动导致锚点失配时装配立即失败等待人工
   复查，绝不静默漏掉覆盖。
3. **锚点匹配前归一化 CRLF。** Windows CI 的 git autocrlf 会把检出内容转成 CRLF，
   LF 写死的锚点会整体失配（v0.3.14 首次构建的事故）。
4. **prepare 与 configure 的分工**：prepare 在 `yarn install` 之前跑，管源码级
   覆盖与插件注入；configure 在打包前跑，管品牌文案、Logo 与 electron-builder
   参数。同一主题的两个阶段函数放同一个 overlay 文件。
