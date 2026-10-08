# TokensCowork v{{VERSION}}

{{SUMMARY_ZH_用一两句话直接描述主要功能与修复}}

[中文](#本次更新) | [English](#whats-new)

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

| 组件 / 插件 | 版本 | 变化说明 |
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
3. 首次打开及签名、公证状态：{{MACOS_SIGNING_AND_PROMPTS_ZH}}

### 从旧版本升级

- 数据与配置保留情况：{{UPGRADE_DATA_ZH}}
- 需要执行的迁移或兼容性操作：{{MIGRATION_ZH}}
- 插件升级、重启或重新授权要求：{{PLUGIN_UPGRADE_ZH}}

## 验证结果

| 检查项 | 结果与验证范围 |
|---|---|
| 产品装配与固定提交 | {{ASSEMBLY_RESULT_ZH}} |
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

| Component / Plugin | Version | Changes |
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
3. First launch, signing and notarization: {{MACOS_SIGNING_AND_PROMPTS_EN}}

### Upgrading from an Earlier Version

- Data and configuration retention: {{UPGRADE_DATA_EN}}
- Required migration or compatibility steps: {{MIGRATION_EN}}
- Plugin updates, restarts or reauthorization: {{PLUGIN_UPGRADE_EN}}

## Verification

| Check | Result and scope |
|---|---|
| Product assembly and pinned commits | {{ASSEMBLY_RESULT_EN}} |
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
