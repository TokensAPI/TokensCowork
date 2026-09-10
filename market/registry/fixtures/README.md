# 验收 fixture

这里的包不是插件，也不进插件目录。它们只用来验证私有 Registry 到市场的完整链路：
Registry 鉴权 → 市场 `/registry/` 代理 → 组织/API Key 权限。

`market-e2e` 是最小的私有包（`@tokensapi-private/*`，匿名读取被拒绝），发布需要在
`config.yaml` 发布白名单中的账号；`market-e2e-public` 是同一个 Registry 上的公开包
（`@tokensapi/*`，`access: $all`），用来验证反方向：来源相同，但市场把它按公开条目
匿名回源，无需任何授权就能装。两个包一起才能证明「来源不决定可见性」。

```bash
cd market/registry/fixtures/market-e2e        # 或 market-e2e-public
npm publish --registry=https://npm.tokensapi.ai/
```

包发布后长期留在 Registry 上，市场目录里的验收条目用完即删：公开验收条目留在目录里
会让所有客户看到一个没有意义的插件，需要复验时重新登记一次即可。

包里不写死 Registry 地址，发到哪里由 `--registry` 或 `.npmrc` 决定。改动内容后请
提升 `version` 再发布，Verdaccio 不允许覆盖同一版本。

包本身没有敏感内容，权限验收靠市场侧的授权关系，不靠包内容保密。
