# DSH 插件开发：从 0 到 1

面向 TokensHarness 产品的插件开发入门。基于上游 DeepSeek Harness / DSH Desktop 的官方文档，
结合本仓库的真实插件示例整理。

上游文档位置（本仓库子模块内）：

- 入门教程三部曲：`desktop/deepseek-harness/docs/user/develop/basic/`
- 工具完整契约：`desktop/deepseek-harness/docs/cookbook/adding-a-tool.md`
- 桌面插件服务：`desktop/docs/plugin-development.md`
- 架构说明：`desktop/docs/architecture.md`

---

## 第 1 课：一个插件的本质 = 一个导出 `apply` 的模块

最小插件就三行有效代码：

```js
export const name = 'hello-plugin'          // 插件名（日志/加载器里显示）

export function apply(ctx) {                // 框架加载时调用
  console.log('[hello-plugin] loaded!')     // ctx 是你和整个系统交互的唯一入口
}
```

**核心心智模型**：DSH 没有"特权核心"，一切功能（包括桌面壳本身）都是插件，
彼此通过 `ctx` 上的服务组合。你的插件不是"外挂"，和官方功能是平级的。

## 第 2 课：怎么把它跑起来（补丁 = 挂载声明）

插件代码自己不会被加载，要在 `cordis.patch.yml`（或开发时的 `--patch` 覆盖文件）里声明：

```yaml
- insert:
    - id: hello                            # 行 id：给上层补丁定位/覆盖用
      name: '/绝对路径/my-plugin.js'        # 开发时可直接指文件；发布后写包名
      config:                              # 可选：传给 apply(ctx, config) 的配置
        greeting: 你好
```

开发环境验证（web 就够，不需要桌面端）：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
# 启动日志里看到 [hello-plugin] loaded! 即成功
```

补丁是分层应用的：bundle 层 → profile 层 → 用户层，后者可以按 `id` 覆盖前者的
`config` 或加 `disabled: true` 停用。本产品停用上游 desktop-updates 插件用的就是这机制
（见 `build/prepare-desktop.mjs`）。

## 第 3 课：三个必学的 ctx 惯用法

**① `inject` 声明依赖** —— 需要什么服务，声明了框架才保证它就绪后再调你：

```js
export const inject = ['tools']       // apply 运行时 ctx.tools 一定可用
```

**② `ctx.effect()` 管理资源** —— 所有需要清理的东西（定时器、连接、注册）都包在
effect 里，返回清理函数，插件卸载时框架自动调用：

```js
ctx.effect(() => {
  const timer = setInterval(poll, 5000)
  return () => clearInterval(timer)    // 卸载时自动执行
}, '轮询心跳')                          // 标签便于排查
```

本仓库 version-updates 插件的整个主体就是一个大 effect —— 这就是为什么
`dsh plugin remove` 后它能干净退场（托盘项消失、定时器清掉、请求中止）。

**③ `Config` Schema 声明配置** —— 用 schemastery 定义带默认值和校验的配置：

```js
import Schema from '@deepseek-ai/schemastery'
export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
})
```

用户在补丁里写的 `config:` 会先过这层校验再进 `apply`。

## 第 4 课：第一个有用的插件 —— 给模型加个工具

最常见的插件形态（10 分钟能跑通）：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',       // 模型看到的说明
    parameters: {
      name: { type: 'string', required: true },   // 框架自动校验参数
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

跑起来后在 Web UI 里说"用 greet 工具向 Ada 打招呼"，模型就会调用它。

要点：

- `execute` 返回**结构化值**（不是散文），`render` 负责转成模型可见内容
- 抛异常 = 工具报错（`isError`）
- 长任务要响应 `exec.signal` 取消
- 后台任务走 `ctx.jobs.start()`，详见 cookbook

## 第 5 课：插件的几种形态（按需选）

| 形态 | 注册方式 | 本仓库/上游例子 |
|---|---|---|
| **工具**（模型能调） | `ctx.tools.register` | 上游 `packages/shell/tool-bash` |
| **Host 服务/后台逻辑** | effect + 定时器/网络 | `plugins/tokens_DshVersionUpdates_code` |
| **Web 界面**（浏览器侧） | `package.json` 的 `dsh.client` 声明 | `plugins/tokens_DshSkillsUI_code` |
| **LLM 适配器 / 会话节点** | 见 harness cookbook | `docs/cookbook/adding-an-llm-adapter.md` |
| **Desktop 专用** | `inject: ['desktopProfiles', 'desktopPnpm']` | `desktop/docs/plugin-development.md` 示例 |

**Desktop 注意事项**（官方红线）：

- 第三方插件**只能**依赖 `desktopProfiles` 和 `desktopPnpm` 两个公开桌面服务
- `desktopRuntime`（本产品 version-updates 插件在用）属于**内部接口**，官方不保证兼容。
  产品自有插件可以用，但要配锚点校验防上游变动（参考 `build/prepare-desktop.mjs` 的做法）
- 想同时兼容 web 和 desktop：别把桌面服务放顶层 `inject`，
  用 `ctx.get('desktopProfiles')` 动态探测，探测不到走普通 DSH 路径

## 第 6 课：发布形态（包结构）

对照 `plugins/tokens_DshVersionUpdates_code`，标准结构：

```
my-plugin/
├── package.json      # name（包名）、main、"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml  # 挂载声明（第 2 课那段）
├── index.js          # export name / inject / Config / apply
├── index.d.ts        # 类型声明（可选但推荐）
├── identity.js       # 可调参数唯一入口（本产品约定，推荐）
└── test/             # node --test 单测
```

`dsh.bundle.patch` 是关键：装了你的包之后，DSH 按它找到补丁把插件挂上。

三种名字各管一处，别混：

| 名字 | 位置 | 用途 |
|---|---|---|
| 包名（如 `@tokens/dsh-version-updates`） | `package.json` 的 `name` + 补丁的 `name:` | loader 按它 import |
| Cordis 插件名（如 `tokens-dsh-version-updates`） | `export const name` | harness 日志/加载器显示 |
| 补丁行 id（如 `tokens-version-updates`） | 补丁的 `id:` | 上层补丁定位/覆盖 |

分发三条路：

1. **npm 发布**（标准）：`dsh plugin add @scope/name`
2. **GitHub 归档**（免发布）：`dsh plugin add https://github.com/<owner>/<repo>/archive/refs/heads/main.tar.gz`
3. **产品内置**：登记进 `product.json` + `enabledByDefault: true` + `yarn product:refresh-lock`，
   打进安装包，用户拿到就有

安装/卸载都要重启应用才进 Loader 组合；改补丁里的 `config:` 热生效不用重启。

## 第 7 课：动手路线（建议顺序）

1. **起步**：跑通 hello-plugin + greet 工具（第 1-4 课，纯 web，不用打包）
2. **进阶**：读本仓库两个真实例子
   - `plugins/tokens_DshVersionUpdates_code` —— Host 后台型完整范本：
     effect 生命周期、状态持久化、配置化（identity.js 模式）、单测
   - `plugins/tokens_DshSkillsUI_code` —— web client 型
3. **系统学**：上游文档按序 —— `basic/` 教程三部曲 → `adding-a-tool.md` →
   `plugin-development.md` → `architecture.md`
4. **守则**（上游生态倡议，值得记住）：
   - **组合优先**：用官方 slot / service / patch 组合能力，不覆盖别人内部实现
   - **声明清晰**：依赖写进 `inject`，不依赖运行时巧合
   - **兼容优先**：升级保持向后兼容，不破坏已有组合

## 测试与发布检查清单

插件至少应覆盖（来自上游要求 + 本产品实践）：

- [ ] 在普通 DSH（无 Desktop service）中仍能加载，或按定义保持 pending
- [ ] `node --test` 单测通过；配置覆盖有专门测试
- [ ] 资源清理：卸载后定时器、请求、注册项全部释放（effect disposer 里做）
- [ ] 网络失败静默降级，不崩溃、不弹无意义报错
- [ ] 静态文件（package.json / cordis.patch.yml）与代码常量一致性有守卫测试
- [ ] 插件变更后重启应用，bundle 进入下一次 Loader 组合
