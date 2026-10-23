# 上游覆盖模块

所有对上游 Desktop、DSH 和插件副本的产品加工都是“覆盖”。每个覆盖只在一处登记，即所在模块的 `overlays.mjs`。
执行器 `pipeline/overlay-engine.mjs` 按登记逐条执行；`yarn product:overlays` 根据同一份登记列出、反查和体检。
覆盖只修改生成的 staging，不改 `desktop/`、`plugins/` 子模块源码。

## 一个模块里有什么

| 文件 | 作用 |
| --- | --- |
| `overlays.mjs` | **登记表**：本模块每个覆盖的 id、阶段、目标文件、转换函数、原因、删除条件 |
| `<主题>-overlay.mjs` | 纯转换函数：输入上游文本，返回加工后的文本，不读写磁盘 |
| `assets/`、`*.spec.ts`、`*.inc` | 复制或拼接进 staging 的资源、源码和产品回归 |
| `*.test.mjs` | 外层测试，以固定的上游源码为输入 |
| `staging-*.mjs`、`*-regression.mjs` | 检查脚本，不修改 staging，在登记表的 `checks` 中说明由谁调用 |
| `review.json` | 会随复查变化的数据：pin 基线和验证证据 |
| `README.md` | 模块职责和验证命令 |

模块里任何未被登记表引用、也不是检查脚本的文件，`--check` 都会报错。未接入的历史代码不会被悄悄保留。

## 装配阶段

| 阶段 | 入口 | 修改什么 |
| --- | --- | --- |
| `prepare` | `staging-prepare.mjs` | 刚复制的上游源码，在注入产品插件之前 |
| `assemble` | `staging-prepare.mjs` | 已复制进 staging 的产品插件副本 |
| `installed` | `staging-runtime-patch.mjs` | `yarn install` 后的 npm 运行时；必须可重复执行 |
| `plugins` | `staging-plugins-compile.mjs` | 产品插件编译产物 |
| `configure` | `staging-product-configure.mjs` | 打包前的产品身份、品牌、安装器、签名与更新来源 |

同一阶段内按模块 `platform → market → runtime → updates → branding → guard`、再按登记表顺序执行。
多个覆盖修改同一文件时，后一个读取前一个的结果；阶段内全部成功后才写盘。
`plugins` 与 `configure` 不允许修改同一文件，因此本地开发和正式构建的执行先后不影响结果。

## 登记字段

```js
{
  id: 'runtime.skip-setup-wizard',     // <模块>.<名称>，报错和体检都用它
  phase: 'prepare',
  upstream: ['desktop'],               // desktop | dsh | plugin:<id> | market-server | product
  kind: 'customization',               // customization 产品定制 | compatibility 版本适配 | workaround 临时修复
  when: ({ product }) => ...,          // 可选：条件启用
  files: { main: desktopFiles.main },  // staging 相对路径，常用路径集中在 pipeline/stage-targets.mjs
  apply: ({ main }) => ({ main: skipDesktopSetupWizard(main) }),
  // 或 copy: [[来源, staging 路径]]；或 run: ctx => {}（仅用于二进制资产等生成型步骤，并写 targets）
  why: '为什么需要',
  retireWhen: '什么条件下删除',
}
```

锚点统一使用 `pipeline/anchors.mjs` 的 `replaceOnce / insertAfter / requireOnce / replacePatternOnce`。
失配时报错格式固定为 `[覆盖 id] 目标文件: 锚点应出现 1 次，实际 N 次：…`。

## 日常操作

| 要做什么 | 怎么做 |
| --- | --- |
| 某个文件被谁改了 | `yarn product:overlays --file src/main.ts` |
| 看一个模块的全部覆盖 | `yarn product:overlays runtime` |
| 新增覆盖 | 在模块里写纯转换函数和测试，在 `overlays.mjs` 登记；路径多处使用时加到 `stage-targets.mjs` |
| 修改覆盖 | 改转换函数，跑 `yarn test:build <模块>`；在 `review.json` 补验证证据 |
| 删除覆盖 | 删登记条目、转换函数及其测试；`--check` 会提示遗留的未引用文件 |

## 上游升级

1. 修改 `product.json` 的 pin 后运行 `yarn product:overlays --doctor`。它在 `.build/desktop-overlay-doctor` 中重新装配，逐条执行覆盖，输出：
   - `✔ 生效`：覆盖仍在改变上游内容。
   - `○ 无变化`：上游可能已经修复，是删除候选。确认后删掉，再让未经加工的上游通过相同回归。
   - `✖ 失败`：锚点或结构变了，按报错中的 id 和文件修改。
   - `◌ / ·`：已安装依赖或生成型步骤，需要完整装配后才能判定。
   - `△`：pin 变化后，被覆盖文件在新旧 pin 之间的 `git diff --stat`。没有覆盖但上游新增的品牌文案、入口，由构建中的 staging 检查拦截。
2. 处理后运行 `yarn test:build`，再用独立 staging 跑 `yarn product:check-desktop`。
3. **插件真实宿主契约**：`product:check-desktop`（以及 CI 的 Windows 质量门禁）最后一步 `yarn product:host-contracts` 会把每个内置插件（按 pin）和市场插件（`build/pipeline/plugin-host-contracts.json` 列的仓库默认分支）隔离检出，带 `DSH_HOST_ROOT` 跑它们自己的 `npm run check:host`——插件用到的每个宿主接口对装配好的宿主各调一次。任一插件红，先在该插件仓库修并发版、换 pin，再发产品；不允许"先发产品、插件以后再说"（0.7.0–0.7.3 连接中心全坏四个版本没被发现，就是因为以前没有这一步）。没有 `check:host` 的内置插件必须在配置的 `exempt` 里写明原因。紧接着的最后一步 `scripts/test-product-plugins.mjs --fail-fast` 跑每个内置插件固定 pin 上的 `test:cases`，其中的 HOST 用例用同一个 staging 宿主（`TOKENS_HOST_ROOT` / `DSH_HOST_ROOT`）；它以前是独立 CI 任务，没有 staging 就没有宿主。CI 里这一步带 `GH_TOKEN`（RELEASE_TOKEN），因为市场插件里会议转写是私有仓库。
   - **验门禁分辨力**不要用 `--pin <id>=<旧提交>`：那会连旧用例一起跑，旧用例当然绿。正确做法是取当前默认分支的快照，只把被测源码文件换回旧版（如 `git checkout v2.9.6 -- plugin-src/host/modern-harness-api.mjs`），再带 `DSH_HOST_ROOT` 跑 `npm run check:host`，必须红；换回当前版必须绿。2026-10-22 主控实测：连接中心 2.9.6 的桥在 0.2.1-rc.2 上整段 HOST-RPC/HOST-CHANNEL 红（`Cannot read properties of undefined (reading 'signal')`，与用户微信报错一致），2.9.7 绿。各插件仓库的 `check:host -- --mutate` / `verify-host-contract-mutations.mjs` 是同一思路的常驻版本。
4. 人工更新对应模块 `review.json` 的 `baseline` 和 `evidence`。工具不会自动删除覆盖，也不会自动更新基线。

完整的升级风险清单见[上游升级检查指南](../../docs/upstream-upgrade.md)。
锚点匹配或 pin 未变不等于行为正确，局部测试不能替代完整 Market、RPC、许可证、安装与跨平台验收。

## 模块职责

| 模块 | 负责什么 | 说明 |
| --- | --- | --- |
| platform | 系统代理回退、Windows ACL 与安装器、打包身份、macOS 单架构签名与公证 | [README](platform/README.md) |
| market | 固定市场来源、鉴权、插件更新、私有 Registry、发现首页、弹窗定位 | [README](market/README.md) |
| runtime | DSH 版本、首次向导、stderr、外部浏览器登录、RPC、压缩、联网搜索设置 | [README](runtime/README.md) |
| updates | 关闭官方更新，配置产品 Release 来源与更新菜单 | [README](updates/README.md) |
| branding | 产品身份、文案、提示词、Logo 与图标、旧数据迁移、隐藏上游云入口 | [README](branding/README.md) |
| guard | 内置循环护栏时停用上游重复工具提醒 | 只有一条登记 |
