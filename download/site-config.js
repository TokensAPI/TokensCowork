/**
 * 下载页的可编辑配置。
 *
 * repository 使用 "owner/repository" 格式。页面会通过 GitHub 公共 API
 * 自动读取最新 Release，并按安装包文件名识别 Windows、macOS arm64 和
 * macOS amd64 版本。保存后直接重新部署本目录即可。
 */
window.DOWNLOAD_PAGE_CONFIG = {
  defaultLanguage: "zh",
  productName: "TokensHarness",
  eyebrow: "TokensHarness Desktop",
  headline: "把 AI 全能助手\n带到你的桌面",
  description: "专注、流畅、开箱即用。无需繁琐配置，在熟悉的桌面环境中开始构建。",
  notice: "这是一个TokensHarness团队维护的项目。",
  repository: "TokensAPI/tokens_TokensHarness_code",
  fallbackVersion: "0.1.2",
  footerText: "Tokens进,万物出",

  // 英文内容。切换到 EN 后使用这些字段；未填写的字段会沿用中文配置。
  english: {
    productName: "TokensHarness",
    eyebrow: "TokensHarness Desktop",
    headline: "Bring your all-in-one AI assistant\nto the desktop",
    description: "Focused, fluid, and ready out of the box. Start building in a familiar desktop environment without complicated setup.",
    notice: "A project maintained by the TokensHarness team.",
    footerText: "Tokens in, possibilities out"
  },

  // 如需临时覆盖 GitHub API 返回的地址，可填写完整 URL；留空则自动解析 Release。
  downloadOverrides: {
    windows: "",
    macArm64: "",
    macAmd64: ""
  }
};
