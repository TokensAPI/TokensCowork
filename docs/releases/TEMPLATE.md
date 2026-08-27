# TokensCowork v{{VERSION}}

{{SUMMARY}}

## 本次更新

### 新增

- {{ADDED}}

### 修复

- {{FIXED}}

### 优化

- {{IMPROVED}}

## 下载说明

| 系统 | 架构 | 安装包 |
|---|---|---|
| Windows | amd64 | `TokensCowork-{{VERSION}}-windows-amd64-installer.exe` |
| macOS | Apple Silicon | `TokensCowork-{{VERSION}}-macos-arm64-installer.dmg` |
| macOS | Intel | `TokensCowork-{{VERSION}}-macos-amd64-installer.dmg` |

## 安装说明

### Windows

1. 下载 Windows 安装器并双击安装。
2. 未签名版本可能出现 SmartScreen 提示，请确认来源为本仓库 Release。

### macOS

1. Apple Silicon 用户下载 `arm64`，Intel 用户下载 `amd64`。
2. 打开 DMG，将 TokensCowork 拖入“应用程序”。
3. 未签名版本首次启动时需要右键选择“打开”。

## 验证结果

- Windows amd64 构建与安装包校验：{{WINDOWS_RESULT}}
- macOS arm64 构建、架构与 DMG 校验：{{MACOS_ARM64_RESULT}}
- macOS amd64 构建、架构与 DMG 校验：{{MACOS_AMD64_RESULT}}
- 三平台版本、commit 与 SHA-256：{{CONSISTENCY_RESULT}}

## 已知限制

- Windows 安装器暂未进行 Authenticode 签名。
- macOS 应用暂未进行 Apple 签名和公证。
- {{OTHER_LIMITATIONS}}

## 完整变更

[查看 v{{PREVIOUS_VERSION}}...v{{VERSION}} 的全部提交]({{CHANGELOG_URL}})
