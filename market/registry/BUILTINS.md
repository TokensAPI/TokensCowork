# 内置组件归档

内置组件以 product.json 固定的包名、版本及 Git commit 为准，管理后台从生成的
product-components.json 展示，只读，不写入可安装插件目录或授权表。显示的版本是产品
构建版本，不是访问后台用户本机的安装版本。更新产品清单后运行市场 build 并部署后台。

2026-09-23 已将产品 0.5.12 的缺失组件发布到 https://npm.tokensapi.ai/，使用 bundled 标签，
不覆盖 latest、不向公开 npm 发布：

| 包 | 版本 | 来源 |
| --- | --- | --- |
| @tokens/dsh-version-updates | 0.1.0 | ba5f3455d71f53b4d4a4ab1d60954d3c6cbe4369 |
| dsh-tokensapi-ui | 0.2.22 | product.json 指定的 SHA256 校验 tgz |
| @tokens/dsh-model-manager | 0.2.22 | 7dd71aac42532a66d5473972b244422ac2c140e8 |
| tokens-dsh-web-search | 0.2.0 | c297f003118a2166682ce1107cbdeb9bbae67c13 |
| @tokens/dsh-loop-guard | 0.1.0 | faa3cc317d3d51046c557218e6a8ee33a6ab13aa |
| @tokensapi/dsh-login | 0.1.5 | 仓库已有版本，未重新发布 |

非 UI 包从固定 commit 的 git archive 在 .build/desktop/builtin-registry 下生成，
没有修改子模块。更新插件用原 scripts/build.mjs 生成 dist/client.js，模型插件用原 Vite
配置生成 dist/main.js。更新插件的 private 标记只在发布副本中设为 false。
发布使用 npm publish --ignore-scripts --tag bundled --registry=https://npm.tokensapi.ai/。
未来发布前必须确认构建产物完整，不能直接忽略脚本后发布缺失 dist 的源代码。

这是内置源码/产物的 Registry 归档，不是独立安装兼容性承诺：桌面构建仍按产品清单
应用 runtimeDependencies 等适配，Registry 归档不改变桌面构建来源。已有版本不可覆盖，
更新内容必须由插件仓库正式发布新版本，再调整产品 pin。包在私有 Registry 不等于用户可安装，
普通用户访问仍受 Registry 和市场的权限限制。
