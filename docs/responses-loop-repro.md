# Responses 协议循环:复现与 loop-guard 验证指南

本指南配套 `scripts/test-responses-loop.mjs` 与 `scripts/test-loop-guard-live.mjs`
(分支 `test/responses-protocol-loop`),用于复现 session.jsonl 中的工具调用循环
(同一 grep 命令连续重复 58 次),并端到端验证 `feature/loop-guard` 分支的
tokens-loop-guard 插件。

## 准备

```bash
git fetch origin && git checkout test/responses-protocol-loop
```

需要一个模型 endpoint,二选一:

- **直连 vLLM**:SSH 隧道 `ssh -L 8081:10.90.0.3:8080 <server>`(或 VS Code 端口转发),
  脚本默认 `--url http://127.0.0.1:8081`,无需 key
- **tokensapi 网关**:`--url https://tokensapi.ai --key sk-...`

模型行为有随机性,单次结果会波动,请看 6-10 轮的统计趋势;网关偶发连接超时,
脚本记为 `FETCH-ERROR` 并继续,不影响判定。

## A. 复现「Responses 协议循环」(不需要插件)

场景:N 轮完全相同的 function_call/function_call_output 历史(取自真实会话),
看模型下一步是否继续发出同一调用。

```bash
# 核心对照:responses vs completions
node scripts/test-responses-loop.mjs --url http://127.0.0.1:8081 --protocol responses   --repeats 8 --rounds 6 --temperature 0.1
node scripts/test-responses-loop.mjs --url http://127.0.0.1:8081 --protocol completions --repeats 8 --rounds 6 --temperature 0.1
```

判定:每轮输出 `REPEAT`(继续发同一 grep,循环)或 `BREAK`(换命令/输出文本);
`DSML` 表示工具调用以 `<｜DSML｜tool_calls>` 原文泄漏在文本里(协议转换脆弱的表现)。

基准数据(deepseek-v4-flash,N=8):

| 条件 | responses | completions |
|---|---|---|
| temp=0.1(服务端原默认) | 6/6 REPEAT | 5/6 REPEAT |
| temp=1.0(官方 agentic 推荐) | 3/6 REPEAT | 4/6 REPEAT |
| temp=0 | 3/3 REPEAT | 1/3 REPEAT |

换 `--url https://tokensapi.ai --key ...` 可对照网关与直连行为一致(网关透传);
`--repeats 32` 可复现「长链锁死」(两种协议都 3/3 REPEAT)。

## B. 验证 loop-guard 有效(端到端,真实插件 × 真实模型)

需要 tokens-loop-guard 插件源码(`feature/loop-guard` 分支的
`plugins/tokens_DshLoopGuard_code` 子模块,或单独 clone 插件仓库)。

```bash
node scripts/test-loop-guard-live.mjs \
  --plugin <tokens-loop-guard 插件目录> \
  --prime 8 --temperature 0.1 --max-steps 12
```

`--plugin` 默认依次尝试:环境变量 `LOOP_GUARD_PLUGIN` →
`plugins/tokens_DshLoopGuard_code`。插件依赖 `@deepseek-ai/schemastery`:
指向 `.build/desktop` 装配产物内的插件目录可自动解析;指向裸 clone 时先在插件目录
`npm install`。

驱动器用最小 agent 循环替代完整 harness:模型(responses 协议)→ function_call →
罐头执行结果 → 真实插件的 `tools/post-execute` 监听器 → accept(附提醒)/block
(替换为纠错反馈)→ 历史回灌。

预期结果:

- **guard on(默认)**:step 1-2 重复,step 3 输出 `reminded`(提醒注入),
  step 4 模型停止重复、转向文本回复
- **对照 `--guard off`**:每一步都是 `exec`,同一 grep 无限重复
- 加 `--replay-reasoning` 可复刻真实会话的 reasoning 回放锚定条件
- 无误伤验证:不加 `--prime` 时,模型多样化探索 20 步,guard 完全不触发

## C. 单元测试(不依赖模型)

```bash
cd <插件目录> && npm install && npm test   # 12 项,含硬阻断(kind=block)路径
```

## 结论摘要(实测数据支持)

1. 循环不是 tokensapi 网关造成的:直连 vLLM 与经网关行为一致(temp=0 逐轮对齐)
2. Responses 协议格式本身更易诱发重复;`--override-generation-config temperature: 0.1`
   把倾向锁死(100%),调回官方推荐 1.0 后降到 ~50%
3. DSML 泄漏与 prefix-caching 组合问题分别跟踪上游 vllm-project/vllm#54686 与
  #50188(截至 2026-09-17 均 OPEN,均不在 sm120-pr-41834 构建内)
4. tokens-loop-guard(`feature/loop-guard`)是不依赖采样运气的确定性刹车
