# 产品装配（assembly）

把只读的 Desktop 子模块加工成 TokensCowork 产品的全部装配逻辑。所有改写只发生在
生成目录 `.build/desktop/`，子模块永远不动。

## 目录

```text
assembly/
├─ prepare.mjs        装依赖前的装配：重建 staging、注入插件与源码覆盖
├─ configure.mjs      打包前的配置：品牌、Logo、安装器与 electron-builder 参数
├─ refresh-lock.mjs   默认插件或生产依赖变化后重新生成 build/product.yarn.lock
├─ patch-runtime.mjs  install 后打包前的运行时补丁（预设健康检查 asar 感知）
├─ external-composer-runtime.txt  外部 composer 运行时清单（patch-runtime 消费）
├─ overlays/          产品覆盖，按主题组织文件或目录；两个入口只做调度
│  ├─ branding.mjs           品牌：锚点校验、主进程改写（含旧用户数据迁移）、
│  │                         Logo 替换、补丁层品牌（UI 品牌停用 + 系统提示词身份）
│  ├─ updates.mjs            更新：停用上游更新、更新菜单验收、更新插件产品配置
│  ├─ market/                插件市场相关覆盖与测试
│  │  ├─ market-source.mjs   来源、fake-IP、界面、安装更新与上游测试适配
│  │  ├─ market-auth.mjs     产品市场 API Key 透传与目录缓存隔离
│  │  ├─ market-auth.test.mjs 透传安全边界与覆盖锚点测试
│  │  └─ market-installed-ui.mjs 已安装插件与系统组件分组展示
│  ├─ windows-acl.mjs        Windows ACL 启动链：宿主控制台注入、基础设施熔断
│  ├─ windows-installer.mjs  Windows 安装器：升级保护 nsh、NSIS 资源固定
│  └─ desktop-runtime.mjs    桌面运行时：向导跳过、市场默认、stderr 保护等
└─ assets/            装配期复制进 staging 的产品资产
   ├─ brand/                 Logo 与客户端品牌组件
   └─ windows/
      ├─ acl/                ACL 宿主控制台与熔断的源码及测试
      └─ installer/          NSIS 覆盖升级保护脚本
```

## 约定

1. **覆盖进 overlays/，入口只调度。** 新增产品覆盖时在对应主题文件或目录里写导出函数，
   再到 prepare.mjs / configure.mjs 的对应分节调用；没有合适主题时新建文件并在
   本 README 登记。
2. **每个覆盖自带锚点守护。** 上游代码变动导致锚点失配时装配立即失败等待人工
   复查，绝不静默漏掉覆盖。
3. **锚点匹配前归一化 CRLF。** Windows CI 的 git autocrlf 会把检出内容转成 CRLF，
   LF 写死的锚点会整体失配（v0.3.14 首次构建的事故）。
4. **prepare 与 configure 的分工**：prepare 在 `yarn install` 之前跑，管源码级
   覆盖与插件注入；configure 在打包前跑，管品牌文案、Logo 与 electron-builder
   参数。同一主题的两个阶段函数放同一个 overlay 文件。
