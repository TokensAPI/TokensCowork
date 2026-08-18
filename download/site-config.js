/**
 * 下载页的可编辑配置。
 *
 * repository 使用 "owner/repository" 格式。页面会通过 GitHub 公共 API
 * 自动读取最新 Release，并按安装包文件名识别 Windows、macOS arm64 和
 * macOS amd64 版本。保存后直接重新部署本目录即可。
 */
window.DOWNLOAD_PAGE_CONFIG = {
  productName: "TokensHarness",
  eyebrow: "TokensHarness Desktop",
  headline: "把 AI 全能助手\n带到你的桌面",
  description: "专注、流畅、开箱即用。无需繁琐配置，在熟悉的桌面环境中开始构建。",
  notice: "这是一个TokensHarness团队维护的项目。",
  repository: "TokensAPI/tokens_TokensHarness_code",
  fallbackVersion: "0.1.0",
  footerText: "Tokens进,万物出",

  // 如需临时覆盖 GitHub API 返回的地址，可填写完整 URL；留空则自动解析 Release。
  downloadOverrides: {
    windows: "",
    macArm64: "",
    macAmd64: ""
  }
};
