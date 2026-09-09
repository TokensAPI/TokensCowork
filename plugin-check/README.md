# dsh-plugin-check

TokensCowork / DSH 插件合格性体检。给所有插件开发者的统一标准:一条命令,当场知道你的插件**能否安全装入宿主、会不会把用户的 Cowork 搞崩**。同一套规则同时用于:开发者本地自查、插件仓库 CI、插件市场上架门禁。

## 用法

```bash
# 在插件目录里
npx @tokensapi/dsh-plugin-check

# 指定目标运行时(启用兼容范围判定;当前产品运行时版本见市场公告)
npx @tokensapi/dsh-plugin-check --runtime 0.1.3-alpha.1

# 只跑离线清单体检(秒级,无网络)
npx @tokensapi/dsh-plugin-check --skip-smoke

# 机器可读输出(CI / 市场门禁)
npx @tokensapi/dsh-plugin-check --json
```

退出码:`0` 合格,`1` 存在 error(`--strict` 时 warning 也计入)。冒烟失败时加 `--keep-workspace` 保留临时工作区排查。

## 体检分两个阶段

**阶段① 清单体检**(纯静态、离线、秒级):检查 package.json 与 cordis 补丁的声明是否合规。
**阶段② 隔离启动冒烟**(联网、约 1–3 分钟):在临时工作区按你声明的 peer 范围装出真实运行时,然后逐补丁行做真实网关启动时做的事——解析入口 → `import` → `new Context()` + `ctx.plugin()` 应用。三段都过,你的插件就不会以"装上即崩"的方式杀死用户的 Cowork。全程 `--ignore-scripts`,你的代码只在一次性子进程里运行,超时即杀。

清单存在 error 时冒烟不执行——先修再跑。

## 规则清单

每条规则都对应一种真实发生过的宿主故障。

| 规则 | 级别 | 内容 | 拦的是什么事故 |
|---|---|---|---|
| M1-manifest | error/warning | package.json 合法,name/version 齐全;预发布版本给出上架提示 | 无法入库 |
| M2-lifecycle | error | 禁止 `preinstall/install/postinstall/prepare` 脚本(构建用 `prepack`) | 安装即执行任意代码;市场受控安装的既有红线 |
| M3-core-peer | error | `@deepseek-ai/cordis*`、`@deepseek-ai/dsh*` 只能是 peerDependencies | 双内核实例 → Symbol 不等 → 服务注册对不上 → **Cowork 启动失败** |
| M4-bundle | error | `dsh.bundle.patch` 必填、文件存在、能解析出插件行 | 宿主无法把插件挂进加载树 |
| M5-row-scope | error | 补丁行只能指向本包(或其子路径) | 插件行劫持挂载其他包 |
| M6-engine | error/warning | `dsh.engine` 声明目标运行时 SemVer 范围;与 `--runtime` 不相交为 error(未声明当前为 warning,将转必填) | 装进不适配的宿主版本 |
| M7-peer-range | warning | 各 `dsh-*` peer 范围应包含目标运行时 | 宿主升级后接口错配,运行时断裂 |
| M8-node-engines | warning | 建议声明 `engines.node`(宿主为 Node 22+) | 语法/API 不可用 |
| M9-license | warning | 建议声明 license | 分发合规 |
| M10-secrets | error/warning | 发布内容不得包含 `.env`、私钥等凭据样式文件 | 凭据泄露 |
| S1-pack | error | `npm pack --ignore-scripts` 必须成功 | 包本身发布不出来 |
| S2-install | error | 按你声明的依赖必须装得出来 | 用户受控安装会同样失败 |
| S3/S4-apply | error | 每个补丁行:入口可解析、`import` 不抛、`ctx.plugin()` 应用不抛(声明 `inject` 等待服务注入属正常,不算失败) | **启动链击穿**——一行 import 失败会拖死整棵插件树 |

## `dsh.engine` 字段

在 package.json 声明你适配的 DSH 运行时范围:

```json
{
  "dsh": {
    "engine": ">=0.1.3-alpha.1 <0.2.0",
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

宿主升级越过你的范围时,市场会把你的插件标记为"待适配"而不是硬载崩溃。

## CI 集成示例

```yaml
# .github/workflows/check.yml
- run: npx @tokensapi/dsh-plugin-check --runtime 0.1.3-alpha.1 --strict
```

## 上架流程中的位置

市场上架要求本工具体检通过:提交插件版本后,门禁会以相同规则复检并记录"验证于运行时 x.y.z"。本地先跑一遍,提交即通过。
