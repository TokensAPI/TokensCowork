(function () {
  "use strict";

  var defaultConfig = window.DOWNLOAD_PAGE_CONFIG || {};
  var previewStorageKey = "tokensharness-download-page-preview";
  var languageStorageKey = "tokensharness-download-page-language";
  var contentKeys = ["productName", "eyebrow", "headline", "description", "notice", "footerText"];
  var editableKeys = contentKeys.concat(["repository"]);
  var iconMarkup = {
    windows: '<span class="windows-mini"><i></i><i></i><i></i><i></i></span>',
    mac: '<span class="apple-mini">●</span>'
  };
  var messages = {
    zh: {
      titleSuffix: "桌面端下载",
      metaDescription: "下载 {product} 桌面客户端。",
      githubView: "在 GitHub 查看",
      recommendedDownload: "推荐下载",
      chooseSystem: "选择你的系统",
      windowsVersion: "Windows 版",
      macAppleVersion: "macOS 版 · Apple 芯片",
      releaseSource: "安装包来自 GitHub Releases",
      allPackages: "全部安装包",
      chooseVersion: "选择适合你的版本",
      connectingRelease: "正在连接 GitHub Releases…",
      noRelease: "暂未读取到公开 Release，下载按钮将前往 GitHub",
      latestVersion: "最新版本 v{version} · {date}",
      totalDownloads: "累计下载 {count} 次",
      windowsRequirement: "Windows 10 / 11 · 64 位",
      macAppleRequirement: "Apple 芯片 · M1 及更新",
      macIntelRequirement: "Intel 芯片 · 64 位",
      download: "下载",
      downloadWindows: "下载 Windows 版本",
      downloadMacApple: "下载 macOS Apple 芯片版本",
      downloadMacIntel: "下载 macOS Intel 版本",
      releaseFallback: "前往 GitHub Releases",
      safeVerifiable: "安全可验证",
      checksumProvided: "每个版本均提供 SHA-256 校验文件",
      releaseNotes: "查看发布说明",
      previewLabel: "TokensHarness 应用界面预览",
      newSession: "新会话",
      workspace: "工作区",
      buildDownloadPage: "构建下载页面",
      optimizeRelease: "优化发布流程",
      justNow: "刚刚",
      yesterday: "昨天",
      settings: "设置",
      standardMode: "标准模式⌄",
      whatToBuild: "今天想构建什么？",
      describeBuild: "描述你想要构建的内容",
      send: "发送 ↑",
      editLanguage: "当前编辑：中文"
    },
    en: {
      titleSuffix: "Desktop Download",
      metaDescription: "Download the {product} desktop client.",
      githubView: "View on GitHub",
      recommendedDownload: "Recommended",
      chooseSystem: "Choose your platform",
      windowsVersion: "Windows",
      macAppleVersion: "macOS · Apple silicon",
      releaseSource: "Installers are hosted on GitHub Releases",
      allPackages: "All downloads",
      chooseVersion: "Choose the right version",
      connectingRelease: "Connecting to GitHub Releases…",
      noRelease: "No public Release found. Download buttons will open GitHub.",
      latestVersion: "Latest v{version} · {date}",
      totalDownloads: "{count} total downloads",
      windowsRequirement: "Windows 10 / 11 · 64-bit",
      macAppleRequirement: "Apple silicon · M1 or newer",
      macIntelRequirement: "Intel processor · 64-bit",
      download: "Download",
      downloadWindows: "Download for Windows",
      downloadMacApple: "Download for macOS Apple silicon",
      downloadMacIntel: "Download for macOS Intel",
      releaseFallback: "Open GitHub Releases",
      safeVerifiable: "Secure and verifiable",
      checksumProvided: "Every release includes SHA-256 checksums",
      releaseNotes: "View release notes",
      previewLabel: "TokensHarness application preview",
      newSession: "New session",
      workspace: "Workspace",
      buildDownloadPage: "Build download page",
      optimizeRelease: "Improve release flow",
      justNow: "now",
      yesterday: "yesterday",
      settings: "Settings",
      standardMode: "Standard mode⌄",
      whatToBuild: "What will you build today?",
      describeBuild: "Describe what you want to build",
      send: "Send ↑",
      editLanguage: "Editing: English"
    }
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function readPreviewConfig() {
    if (!new URLSearchParams(window.location.search).has("edit")) return {};
    try {
      return JSON.parse(window.localStorage.getItem(previewStorageKey) || "{}");
    } catch (_error) {
      return {};
    }
  }

  var previewConfig = readPreviewConfig();
  var config = Object.assign(clone(defaultConfig), previewConfig);
  config.english = Object.assign({}, defaultConfig.english || {}, previewConfig.english || {});
  config.downloadOverrides = Object.assign({}, defaultConfig.downloadOverrides || {}, previewConfig.downloadOverrides || {});

  var storedLanguage = window.localStorage.getItem(languageStorageKey);
  var currentLanguage = storedLanguage === "en" || storedLanguage === "zh" ? storedLanguage : (config.defaultLanguage === "en" ? "en" : "zh");

  function activeContent() {
    return currentLanguage === "en" ? Object.assign({}, config, config.english || {}) : config;
  }

  function translate(key, replacements) {
    var value = (messages[currentLanguage] && messages[currentLanguage][key]) || messages.zh[key] || key;
    Object.keys(replacements || {}).forEach(function (name) {
      value = value.replace("{" + name + "}", replacements[name]);
    });
    return value;
  }

  function repositoryParts() {
    var value = String(config.repository || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
    var parts = value.split("/").filter(Boolean);
    return { owner: parts[0] || "TokensAPI", repo: parts[1] || "tokens_TokensHarness_code" };
  }

  function githubUrl(path) {
    var repo = repositoryParts();
    return "https://github.com/" + repo.owner + "/" + repo.repo + (path || "");
  }

  function apiUrl(path) {
    var repo = repositoryParts();
    return "https://api.github.com/repos/" + repo.owner + "/" + repo.repo + path;
  }

  function applyLanguageMessages() {
    document.documentElement.lang = currentLanguage === "en" ? "en" : "zh-CN";
    document.querySelectorAll("[data-i18n]").forEach(function (element) {
      element.textContent = translate(element.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (element) {
      element.setAttribute("aria-label", translate(element.getAttribute("data-i18n-aria-label")));
    });
    document.querySelectorAll("[data-language]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-language") === currentLanguage));
    });
  }

  function applyConfig() {
    var content = activeContent();
    document.querySelectorAll("[data-config]").forEach(function (element) {
      var key = element.getAttribute("data-config");
      var value = content[key] || "";
      if (key === "headline") {
        element.innerHTML = escapeHtml(value).replace(/\n/g, "<br />");
      } else {
        element.textContent = value;
      }
    });

    applyLanguageMessages();
    document.title = content.productName + " - " + translate("titleSuffix");
    document.querySelector('meta[name="description"]').setAttribute("content", translate("metaDescription", { product: content.productName }));
    ["github-header-link", "github-main-link"].forEach(function (id) {
      document.getElementById(id).href = githubUrl("");
    });
    document.getElementById("copyright-year").textContent = new Date().getFullYear();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character];
    });
  }

  function formatCount(value) {
    return new Intl.NumberFormat(currentLanguage === "en" ? "en-US" : "zh-CN").format(value || 0);
  }

  function formatDate(value) {
    return new Date(value).toLocaleDateString(currentLanguage === "en" ? "en-US" : "zh-CN");
  }

  function findAsset(assets, patterns) {
    return assets.find(function (asset) {
      return patterns.every(function (pattern) { return pattern.test(asset.name); });
    });
  }

  function resolveAssets(release) {
    var assets = release.assets || [];
    return {
      windows: findAsset(assets, [/windows/i, /(amd64|x64)/i, /installer\.exe$/i]),
      macArm64: findAsset(assets, [/macos/i, /arm64/i, /installer\.dmg$/i]),
      macAmd64: findAsset(assets, [/macos/i, /(amd64|x64)/i, /installer\.dmg$/i])
    };
  }

  function isInstallerAsset(asset) {
    return /installer\.(exe|dmg)$/i.test(asset.name || "");
  }

  function totalInstallerDownloads(releases) {
    return releases.reduce(function (sum, item) {
      return sum + (item.assets || []).filter(isInstallerAsset).reduce(function (assetSum, asset) {
        return assetSum + (asset.download_count || 0);
      }, 0);
    }, 0);
  }

  function setDownloadLink(id, url, fallback, asset) {
    var link = document.getElementById(id);
    link.href = url || fallback;
    if (url && asset) {
      link.setAttribute("download", asset.name);
      link.title = asset.name;
    } else {
      link.removeAttribute("download");
      link.title = translate("releaseFallback");
    }
  }

  function recommendedPlatform() {
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
    if (/mac/i.test(platform)) return "macArm64";
    if (/win/i.test(platform)) return "windows";
    return "windows";
  }

  function configureRecommended(urls) {
    var platform = recommendedPlatform();
    var button = document.getElementById("recommended-download");
    var label = document.getElementById("recommended-label");
    var icon = document.getElementById("recommended-icon");
    var fallback = githubUrl("/releases/latest");

    if (platform === "windows") {
      button.href = urls.windows || fallback;
      label.textContent = translate("windowsVersion");
      icon.innerHTML = iconMarkup.windows;
    } else {
      button.href = urls.macArm64 || fallback;
      label.textContent = translate("macAppleVersion");
      icon.innerHTML = iconMarkup.mac;
    }
  }

  function applyFallback() {
    var fallback = githubUrl("/releases/latest");
    var overrides = config.downloadOverrides;
    setDownloadLink("windows-download", overrides.windows, fallback);
    setDownloadLink("mac-arm64-download", overrides.macArm64, fallback);
    setDownloadLink("mac-amd64-download", overrides.macAmd64, fallback);
    configureRecommended(overrides);
    document.getElementById("header-version").textContent = "v" + config.fallbackVersion;
    document.getElementById("release-status").textContent = translate("noRelease");
    document.getElementById("release-notes-link").href = fallback;
    document.getElementById("download-count").textContent = translate("releaseSource");
  }

  async function loadRelease() {
    applyFallback();
    document.getElementById("release-status").textContent = translate("connectingRelease");
    try {
      var requestStamp = Date.now();
      var responses = await Promise.all([
        fetch(apiUrl("/releases/latest?ts=" + requestStamp), { cache: "no-store", headers: { Accept: "application/vnd.github+json" } }),
        fetch(apiUrl("/releases?per_page=100&ts=" + requestStamp), { cache: "no-store", headers: { Accept: "application/vnd.github+json" } })
      ]);
      if (!responses[0].ok) throw new Error("No public release");

      var release = await responses[0].json();
      var allReleases = responses[1].ok ? await responses[1].json() : [release];
      var assets = resolveAssets(release);
      var overrides = config.downloadOverrides;
      var urls = {
        windows: overrides.windows || (assets.windows && assets.windows.browser_download_url),
        macArm64: overrides.macArm64 || (assets.macArm64 && assets.macArm64.browser_download_url),
        macAmd64: overrides.macAmd64 || (assets.macAmd64 && assets.macAmd64.browser_download_url)
      };
      var fallback = release.html_url || githubUrl("/releases/latest");
      var totalDownloads = totalInstallerDownloads(allReleases);

      setDownloadLink("windows-download", urls.windows, fallback, assets.windows);
      setDownloadLink("mac-arm64-download", urls.macArm64, fallback, assets.macArm64);
      setDownloadLink("mac-amd64-download", urls.macAmd64, fallback, assets.macAmd64);
      configureRecommended(urls);

      var version = (release.tag_name || config.fallbackVersion).replace(/^v/, "");
      document.getElementById("header-version").textContent = "v" + version;
      document.getElementById("release-status").textContent = translate("latestVersion", { version: version, date: formatDate(release.published_at) });
      document.getElementById("release-notes-link").href = fallback;
      document.getElementById("download-count").textContent = totalDownloads ? translate("totalDownloads", { count: formatCount(totalDownloads) }) : translate("releaseSource");
    } catch (_error) {
      document.getElementById("release-status").textContent = translate("noRelease");
    }
  }

  async function refreshDownloadCount() {
    try {
      var response = await fetch(apiUrl("/releases?per_page=100&ts=" + Date.now()), {
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json" }
      });
      if (!response.ok) return;
      var releases = await response.json();
      var totalDownloads = totalInstallerDownloads(releases);
      document.getElementById("download-count").textContent = totalDownloads
        ? translate("totalDownloads", { count: formatCount(totalDownloads) })
        : translate("releaseSource");
    } catch (_error) {
      // Keep the last known count when GitHub is temporarily unavailable.
    }
  }

  function initializeDownloadCountRefresh() {
    document.querySelectorAll("#recommended-download, .card-download").forEach(function (link) {
      link.addEventListener("click", function () {
        window.setTimeout(refreshDownloadCount, 6000);
        window.setTimeout(refreshDownloadCount, 30000);
      });
    });
  }

  function initializeLanguageSwitch() {
    document.querySelectorAll("[data-language]").forEach(function (button) {
      button.addEventListener("click", function () {
        var nextLanguage = button.getAttribute("data-language");
        if (nextLanguage === currentLanguage) return;
        currentLanguage = nextLanguage;
        window.localStorage.setItem(languageStorageKey, currentLanguage);
        applyConfig();
        loadRelease();
      });
    });
  }

  function initializeEditor() {
    var params = new URLSearchParams(window.location.search);
    if (!params.has("edit")) return;

    var trigger = document.getElementById("edit-trigger");
    var dialog = document.getElementById("editor-dialog");
    var form = document.getElementById("editor-form");
    trigger.hidden = false;

    function populate() {
      var content = activeContent();
      contentKeys.forEach(function (key) { form.elements[key].value = content[key] || ""; });
      form.elements.repository.value = config.repository || "";
      document.getElementById("editor-language-label").textContent = translate("editLanguage");
    }

    trigger.addEventListener("click", function () { populate(); dialog.showModal(); });
    document.getElementById("editor-close").addEventListener("click", function () { dialog.close(); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (currentLanguage === "en") {
        config.english = config.english || {};
        contentKeys.forEach(function (key) { config.english[key] = form.elements[key].value.trim(); });
      } else {
        contentKeys.forEach(function (key) { config[key] = form.elements[key].value.trim(); });
      }
      config.repository = form.elements.repository.value.trim();
      window.localStorage.setItem(previewStorageKey, JSON.stringify(config));
      applyConfig();
      loadRelease();
      dialog.close();
    });

    document.getElementById("editor-reset").addEventListener("click", function () {
      window.localStorage.removeItem(previewStorageKey);
      config = clone(defaultConfig);
      populate();
      applyConfig();
      loadRelease();
    });

    document.getElementById("editor-export").addEventListener("click", function () {
      if (currentLanguage === "en") {
        config.english = config.english || {};
        contentKeys.forEach(function (key) { config.english[key] = form.elements[key].value.trim(); });
      } else {
        contentKeys.forEach(function (key) { config[key] = form.elements[key].value.trim(); });
      }
      config.repository = form.elements.repository.value.trim();
      var output = "/** Generated by the download page preview editor. */\nwindow.DOWNLOAD_PAGE_CONFIG = " + JSON.stringify(config, null, 2) + ";\n";
      var blob = new Blob([output], { type: "text/javascript;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "site-config.js";
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  initializeLanguageSwitch();
  initializeDownloadCountRefresh();
  applyConfig();
  initializeEditor();
  loadRelease();
})();
