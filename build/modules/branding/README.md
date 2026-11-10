# 品牌覆盖（branding）

负责产品身份、显示文案、Logo、提示词、旧用户数据迁移和上游云入口的显示策略。
产品身份来自根目录 `product.json`；覆盖只写入生成的 staging，源码子模块保持只读。

## 文件职责

| 文件 | 负责什么 |
| --- | --- |
| [overlays.mjs](overlays.mjs) | 覆盖登记表；Logo、已安装运行时文案与图标生成是 run 步骤，其余为纯转换 |
| [branding-overlay.mjs](branding-overlay.mjs) | Desktop 源码中的产品名称、应用标识、原生文案、证书名称、补丁配置与旧数据迁移 |
| [branding-runtime-overlay.mjs](branding-runtime-overlay.mjs) | 已安装 npm 运行时的文案、标题、提示词与声明式预设；隐藏上游云侧栏入口，保留设置和后台服务 |
| [branding-assets.mjs](branding-assets.mjs) | 实际前端 Logo、favicon、安装名称、UI Logo 组件及 Desktop 图标配置；提供资产应用和只读校验函数 |
| `assets/app-mark.svg`、`assets/app-icon.png` | 新原生图标：SVG 用于 macOS 托盘模板，白底圆角 PNG 用于应用、安装包及 Windows/Linux 托盘 |
| `assets/logo-mark.png` | 宿主前端回退 Logo 与 favicon，使用同款白底新图形；UI 插件的品牌与字体由前端独立维护 |
| [assets/generate-product-icons.mjs](assets/generate-product-icons.mjs) | 复制到 staging 后生成 ICO、ICNS 和各 DPI 托盘位图；复用固定上游的应用图标渲染器 |
| [branding-overlay.test.mjs](branding-overlay.test.mjs) | 在临时目录测试覆盖代码，包括正常替换、重复执行、锚点变化和迁移失败 |
| [staging-branding-verify.mjs](staging-branding-verify.mjs) | 只读检查实际 staging 源码、已安装依赖、编译产物与图标是否包含产品品牌 |
| [review.json](review.json) | pin 基线与验证证据 |

## 执行顺序

1. `staging-prepare.mjs` 复制固定上游源码，并应用品牌补丁配置。
2. 安装依赖后，`staging-product-configure.mjs` 应用 Desktop、资产和 npm 运行时覆盖，统一生成图标。源码配置针对本轮新装配执行一次。
3. 编译 Market 和 Desktop 后，`build/build.mjs` 自动调用 `staging-branding-verify.mjs`，检查实际结果；失败会阻止后续打包。

开发由 `scripts/dev-desktop.ps1` 调度装配、配置和编译；正式构建由 `build/build.mjs` 调度。测试文件检查“覆盖代码是否正确”，staging 校验检查“覆盖是否真正进入交付内容”。

## 验证命令

在仓库根目录运行：

| 命令 | 检查什么 |
| --- | --- |
| `yarn test:build branding` | 覆盖代码回归；无需安装依赖或启动 Electron |
| `yarn product:overlays branding --check` | 记录完整性和上游提交基线；关联输入变化时提示复查并返回失败 |
| `node build/modules/branding/staging-branding-verify.mjs` | 已配置并编译的 `.build/desktop`；仅检查，不重新装配或修复 |

隔离 staging 可通过 `PRODUCT_STAGE_NAME` 指定。覆盖检查不会自动更新 `review.json` 的基线，也不会判断上游是否已修复；通过文件检查仍需另做真实安装和界面验收。

原生图形来自设计包 `logo and font (1).zip` 的 `Quicksand_logo.svg`，原样保存为 `app-mark.svg`，不使用 BenchFront 字标，产品名保留 TokensCowork。应用 PNG 按 SVG 渲染为 1024×1024：白底圆角半径 220，黑色图形 704×704 居中（边距 160），RGBA16 / sRGB ICC，符合上游 macOS 图标输入契约。macOS Dock 继续使用上游安全边距；托盘模板保留透明底，由系统反色；Windows/Linux 托盘使用白底确保可见。

Microsoft Store 图标也从应用 PNG 派生，换图后运行 `node build/modules/platform/assets/windows/store/generate.mjs`。宿主回退 Logo 同步应用 PNG，UI 插件由前端独立更新。

网站品牌入口为 `download/logo-mark.svg` 与 `market/server/admin/assets/logo-mark.svg`（与应用 PNG 相同构图）。两站独立部署，各自携带 `fonts/Quicksand-Variable.ttf` 和 `OFL.txt`；下载页在 `styles.css` 声明字体，后台与 API 文档共用 `assets/brand.css`，中文保留系统回退、代码保留等宽字体。后台新增资源必须登记 `market-worker.js` 的静态白名单及 `runtime/adapters.mjs` 的 MIME 类型。

开发时完全退出应用后重新运行 `powershell -File scripts/dev-desktop.ps1`；已安装版需要新安装包才能带入修改。

跨模块顺序与升级规则见[覆盖模块总览](../README.md)。Windows 卸载保护的检查在 platform 模块应用安装器配置时执行。
