# 验收 fixture

这里的包不是插件，也不进插件目录。它们只用来验证私有 Registry 到市场的完整链路：
Registry 鉴权 → 市场 `/registry/` 代理 → 组织/API Key 权限。

`market-e2e` 是最小的私有作用域包（`@tokensapi-private/*`，Registry 上匿名读取被
拒绝），发布需要在 `config.yaml` 发布白名单中的账号；`market-e2e-public` 是同一个
Registry 上的公开作用域包（`@tokensapi/*`，`access: $all`）。两个包分别用来验收
受限条目（授权 Key 才能装）和公开条目（谁都能装）；插件在市场里公开还是受限只由
后台的访问范围决定，与包放在哪个作用域无关。

```bash
cd market/registry/fixtures/market-e2e        # 或 market-e2e-public
npm publish --registry=https://npm.tokensapi.ai/
```

包发布后长期留在 Registry 上，市场目录里的验收条目用完即删：公开验收条目留在目录里
会让所有客户看到一个没有意义的插件，需要复验时重新登记一次即可。

包里不写死 Registry 地址，发到哪里由 `--registry` 或 `.npmrc` 决定。改动内容后请
提升 `version` 再发布，Verdaccio 不允许覆盖同一版本。

包本身没有敏感内容，权限验收靠市场侧的授权关系，不靠包内容保密。
