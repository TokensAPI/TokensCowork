# TokensCowork v{{VERSION}}

{{SUMMARY_ZH_用一两句话直接描述主要功能与修复}}

[中文](#user-content-release-notes-zh) | [English](#user-content-release-notes-en)

<a name="release-notes-zh"></a>

## 本次更新

### ✨ 新增功能

- {{ADDED_ZH_说明新增能力以及在哪里使用}}

### 🐛 问题修复

- {{FIXED_ZH_说明触发场景原有问题与修复后的行为}}

### 🎨 体验优化

- {{IMPROVED_ZH_说明具体体验或性能变化}}

### ⚠️ 其他变更

- {{OTHER_ZH_说明兼容性配置默认值或依赖升级的影响}}

### 内置组件与插件

| 组件 / 插件 | 版本 | 说明 |
|---|---|---|
| Desktop / DSH 运行时 | {{DESKTOP_AND_DSH_VERSION}} | {{DESKTOP_AND_DSH_CHANGE_ZH}} |
| {{PLUGIN_DISPLAY_NAME}} | {{PLUGIN_VERSION}} | {{PLUGIN_CHANGE_ZH}} |

## 下载说明

从 [此版本 Release](https://github.com/TokensAPI/TokensCowork/releases/tag/v{{VERSION}}) 下载与系统和处理器架构对应的安装包。

| 系统 | 处理器 | 安装包 |
|---|---|---|
| Windows | Intel / AMD 64 位（amd64） | [Windows 安装器](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-windows-amd64-installer.exe) |
| macOS | Apple Silicon（arm64） | [Apple Silicon DMG](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-macos-arm64-installer.dmg) |
| macOS | Intel（amd64） | [Intel DMG](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-macos-amd64-installer.dmg) |

- [SHA-256 校验文件](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-SHA256SUMS.txt)
- [内置插件清单](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-plugins.json)
- 支持的系统版本与其他平台说明：{{SUPPORTED_PLATFORMS_ZH}}

## 安装说明

### Windows

1. 下载 Windows amd64 安装器，完全退出正在运行的 TokensCowork。
2. 双击安装器，按提示完成安装。
3. 签名及系统提示：{{WINDOWS_SIGNING_AND_PROMPTS_ZH}}

### macOS

1. 在“关于本机”中确认处理器类型，选择 Apple Silicon 或 Intel 安装包。
2. 完全退出 TokensCowork，打开 DMG，将应用拖入“应用程序”。
3. 从“应用程序”打开 TokensCowork；如出现首次打开确认，点击“打开”。

{{MACOS_SIGNING_AND_PROMPTS_ZH}}

## 验证结果

| 检查项 | 结果与验证范围 |
|---|---|
| 产品装配与固定提交 | {{ASSEMBLY_RESULT_ZH}} |
| 构建与发布维护 | {{BUILD_AND_RELEASE_CHANGES_ZH_记录实际改动及验证结果_无改动时删除本行}} |
| 自动化回归 | {{REGRESSION_RESULT_ZH}} |
| Windows amd64 构建、安装与覆盖升级 | {{WINDOWS_RESULT_ZH}} |
| macOS arm64 构建、架构与安装 | {{MACOS_ARM64_RESULT_ZH}} |
| macOS amd64 构建、架构与安装 | {{MACOS_AMD64_RESULT_ZH}} |
| 三平台版本与 SHA-256 | {{CONSISTENCY_RESULT_ZH}} |
| 真实宿主与关键功能验收 | {{MANUAL_RESULT_ZH}} |

构建与测试记录：[{{WORKFLOW_NAME}}]({{WORKFLOW_URL}})。

## 已知限制

- {{KNOWN_LIMITATION_ZH_说明未修复问题受影响场景及已确认的临时处理方式}}
- {{UNVERIFIED_SCOPE_ZH_说明未完成的验收范围}}

## 完整变更

[查看 v{{PREVIOUS_VERSION}}...v{{VERSION}} 的全部提交](https://github.com/TokensAPI/TokensCowork/compare/v{{PREVIOUS_VERSION}}...v{{VERSION}})

---

<a name="release-notes-en"></a>

## What's New

{{SUMMARY_EN_English_translation_of_the_Chinese_summary}}

### ✨ New Features

- {{ADDED_EN}}

### 🐛 Bug Fixes

- {{FIXED_EN}}

### 🎨 Improvements

- {{IMPROVED_EN}}

### ⚠️ Other Changes

- {{OTHER_EN}}

### Bundled Components and Plugins

| Component / Plugin | Version | Description |
|---|---|---|
| Desktop / DSH runtime | {{DESKTOP_AND_DSH_VERSION}} | {{DESKTOP_AND_DSH_CHANGE_EN}} |
| {{PLUGIN_DISPLAY_NAME_EN}} | {{PLUGIN_VERSION}} | {{PLUGIN_CHANGE_EN}} |

## Downloads

Download the installer for your operating system and processor from [this release](https://github.com/TokensAPI/TokensCowork/releases/tag/v{{VERSION}}).

| System | Processor | Installer |
|---|---|---|
| Windows | Intel / AMD 64-bit (amd64) | [Windows installer](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-windows-amd64-installer.exe) |
| macOS | Apple Silicon (arm64) | [Apple Silicon DMG](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-macos-arm64-installer.dmg) |
| macOS | Intel (amd64) | [Intel DMG](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-macos-amd64-installer.dmg) |

- [SHA-256 checksums](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-SHA256SUMS.txt)
- [Bundled plugin manifest](https://github.com/TokensAPI/TokensCowork/releases/download/v{{VERSION}}/TokensCowork-{{VERSION}}-plugins.json)
- Supported system versions and other platforms: {{SUPPORTED_PLATFORMS_EN}}

## Installation

### Windows Installation

1. Download the Windows amd64 installer and fully quit TokensCowork.
2. Run the installer and follow its instructions.
3. Signing status and system prompts: {{WINDOWS_SIGNING_AND_PROMPTS_EN}}

### macOS Installation

1. Check your processor in About This Mac and select the Apple Silicon or Intel installer.
2. Fully quit TokensCowork, open the DMG, and drag the application into Applications.
3. Open TokensCowork from Applications. If the first-launch confirmation appears, click Open.

{{MACOS_SIGNING_AND_PROMPTS_EN}}

## Verification

| Check | Result and scope |
|---|---|
| Product assembly and pinned commits | {{ASSEMBLY_RESULT_EN}} |
| Build and release maintenance | {{BUILD_AND_RELEASE_CHANGES_EN}} |
| Automated regression | {{REGRESSION_RESULT_EN}} |
| Windows amd64 build, installation and upgrade | {{WINDOWS_RESULT_EN}} |
| macOS arm64 build, architecture and installation | {{MACOS_ARM64_RESULT_EN}} |
| macOS amd64 build, architecture and installation | {{MACOS_AMD64_RESULT_EN}} |
| Cross-platform versions and SHA-256 | {{CONSISTENCY_RESULT_EN}} |
| Real-host and key-feature acceptance | {{MANUAL_RESULT_EN}} |

Build and test records: [{{WORKFLOW_NAME}}]({{WORKFLOW_URL}}).

## Known Limitations

- {{KNOWN_LIMITATION_EN}}
- {{UNVERIFIED_SCOPE_EN}}

## Full Changelog

[View all commits from v{{PREVIOUS_VERSION}} to v{{VERSION}}](https://github.com/TokensAPI/TokensCowork/compare/v{{PREVIOUS_VERSION}}...v{{VERSION}})

<!--
填写规则（仅供维护者阅读，发布页面不显示）：
1. 预发布与稳定版共用本模板。保留首行版本标题、直接描述变化的摘要及六个中英文主章节；两种语言内容一致。
2. 更新按新增、修复、优化、其他分类；无内容的分类可删除，同一变化只写一次。每条写清具体改了什么，以及对功能、使用或安装有什么影响；修复项说明原来的问题与修复后的行为，不直接粘贴提交信息。不编造功能、贡献者或验证结论。
3. 组件信息核对当前标签的 product.json，仅列实际内置组件；说明其用途或具体变化，不用“沿用”“未变化”等占位文案。下载链接、处理器架构、系统要求及签名状态以当前产物为准。
4. 安装说明只保留 Windows 和 macOS 的安装步骤，macOS 签名与公证说明以该版本实际产物为准。确有迁移、重新授权等必要操作时写入“其他变更”，不固定添加旧版升级章节。
5. “本次更新”只写用户可见的功能、修复和体验。编译架构、公证等待恢复、CI 任务调度及发布流水线等实际维护改动仍须记录，放在验证章节的“构建与发布维护”行，写明改动与验证结果，不混入版本功能变化，也不因为调整写法而直接漏掉。无维护改动时删除该行。验证章节区分构建、自动测试和真机验收，未执行的写“未验证”；测试数量、源码提交和工作流链接放在这里。已知限制写具体影响和当前验证边界。
6. 维护者按上一份已成功发布且提供安装包的版本确定预发布的变更范围，不能仅按前一个 Git 标签判断；中间构建失败或未发布的版本，其实际改动必须一并纳入。转稳定版前合并上一稳定版以来的内容并去重。核对范围内全部提交、product.json 的源码固定提交差异及对应插件改动；组件版本号未变也不能省略源码更新带来的功能变化。正文直接写具体变动，不写“相比某版本”“沿用某版本”或说明汇总范围的句子。同步中英文完整变更链接的起止标签。发布脚本不会自动合并内容。
7. 转稳定版使用 Promote Desktop Release 工作流，复用已有标签和安装包。发布状态由 GitHub 元数据管理，不写入摘要；下载页只展示版本改动。
8. 保留两个语言锚点和导航链接。GitHub Release 不生成标题锚点，会为 name 添加 user-content- 前缀；下载页按钮切换所显示的语言。
9. 发布前解析全部占位符，并通过完整模板校验；空章节不能发布。具体发布操作见 docs/manual-release.md。
10. 写作要求示例：不要写“沿用某版本的功能，本说明展示相对某版本的变化”；直接写本次实际增加或修复的能力。没有变化的组件只列版本和用途，不凑更新条目。
11. 归类要求示例：“macOS 安装包已签名并通过 Apple 公证，可按正常流程安装打开”写入体验优化；“分架构构建、保存公证提交、任一包失败即停止”写入构建与发布维护。改写应保留实际改动及其记录，而不是只删文字。
-->
