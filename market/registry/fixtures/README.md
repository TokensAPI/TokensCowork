# 验收 fixture

这里的包不是插件，也不进插件目录。它们只用来验证私有 Registry 到市场的完整链路：
Registry 鉴权 → 市场 `/registry/` 代理 → 组织/API Key 权限。

`market-e2e` 是最小的私有包。发布（需要在 `config.yaml` 发布白名单中的账号）：

```bash
cd market/registry/fixtures/market-e2e
npm publish
```

`publishConfig.registry` 已固定指向本 Registry，不会误发到 npmjs。改动内容后请提升
`version` 再发布，Verdaccio 不允许覆盖同一版本。

包本身没有敏感内容，权限验收靠市场侧的授权关系，不靠包内容保密。
