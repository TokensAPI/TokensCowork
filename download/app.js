(function () {
  "use strict";

  var defaultConfig = window.DOWNLOAD_PAGE_CONFIG || {};
  var storageKey = "tokensharness-download-page-preview";
  var editableKeys = ["productName", "eyebrow", "headline", "description", "notice", "repository", "footerText"];
  var iconMarkup = {
    windows: '<span class="windows-mini"><i></i><i></i><i></i><i></i></span>',
    mac: '<span class="apple-mini">●</span>',
    generic: '<span class="generic-mini">↓</span>'
  };

  function readPreviewConfig() {
    if (!new URLSearchParams(window.location.search).has("edit")) return {};
    try {
      return JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    } catch (_error) {
      return {};
    }
  }

  var config = Object.assign({}, defaultConfig, readPreviewConfig());
  config.downloadOverrides = Object.assign({}, defaultConfig.downloadOverrides || {}, config.downloadOverrides || {});

  function repositoryParts() {
    var value = String(config.repository || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
    var parts = value.split("/").filter(Boolean);
    return { owner: parts[0] || "sobermh", repo: parts[1] || "tokens_TokensHarness_code" };
  }

  function githubUrl(path) {
    var repo = repositoryParts();
    return "https://github.com/" + repo.owner + "/" + repo.repo + (path || "");
  }

  function apiUrl(path) {
    var repo = repositoryParts();
    return "https://api.github.com/repos/" + repo.owner + "/" + repo.repo + path;
  }

  function applyConfig() {
    document.querySelectorAll("[data-config]").forEach(function (element) {
      var key = element.getAttribute("data-config");
      var value = config[key] || "";
      if (key === "headline") {
        element.innerHTML = escapeHtml(value).replace(/\n/g, "<br />");
      } else {
        element.textContent = value;
      }
    });

    document.title = config.productName + " - 桌面端下载";
    document.querySelector('meta[name="description"]').setAttribute("content", "下载 " + config.productName + " 桌面客户端。");
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
    return new Intl.NumberFormat("zh-CN").format(value || 0);
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

  function setDownloadLink(id, url, fallback, asset) {
    var link = document.getElementById(id);
    link.href = url || fallback;
    if (url && asset) {
      link.setAttribute("download", asset.name);
      link.title = asset.name;
    } else {
      link.removeAttribute("download");
      link.title = "前往 GitHub Releases";
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
      label.textContent = "Windows 版";
      icon.innerHTML = iconMarkup.windows;
    } else {
      button.href = urls.macArm64 || fallback;
      label.textContent = "macOS 版 · Apple 芯片";
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
    document.getElementById("release-status").textContent = "暂未读取到公开 Release，下载按钮将前往 GitHub";
    document.getElementById("release-notes-link").href = fallback;
  }

  async function loadRelease() {
    applyFallback();
    try {
      var responses = await Promise.all([
        fetch(apiUrl("/releases/latest"), { headers: { Accept: "application/vnd.github+json" } }),
        fetch(apiUrl("/releases?per_page=100"), { headers: { Accept: "application/vnd.github+json" } })
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
      var totalDownloads = allReleases.reduce(function (sum, item) {
        return sum + (item.assets || []).reduce(function (assetSum, asset) { return assetSum + (asset.download_count || 0); }, 0);
      }, 0);

      setDownloadLink("windows-download", urls.windows, fallback, assets.windows);
      setDownloadLink("mac-arm64-download", urls.macArm64, fallback, assets.macArm64);
      setDownloadLink("mac-amd64-download", urls.macAmd64, fallback, assets.macAmd64);
      configureRecommended(urls);

      var version = (release.tag_name || config.fallbackVersion).replace(/^v/, "");
      document.getElementById("header-version").textContent = "v" + version;
      document.getElementById("release-status").textContent = "最新版本 v" + version + " · " + new Date(release.published_at).toLocaleDateString("zh-CN");
      document.getElementById("release-notes-link").href = fallback;
      document.getElementById("download-count").textContent = totalDownloads ? "累计下载 " + formatCount(totalDownloads) + " 次" : "安装包来自 GitHub Releases";
    } catch (_error) {
      // Fallback links are already active. This also covers API rate limits and private repos.
    }
  }

  function initializeEditor() {
    var params = new URLSearchParams(window.location.search);
    if (!params.has("edit")) return;

    var trigger = document.getElementById("edit-trigger");
    var dialog = document.getElementById("editor-dialog");
    var form = document.getElementById("editor-form");
    trigger.hidden = false;

    function populate() {
      editableKeys.forEach(function (key) { form.elements[key].value = config[key] || ""; });
    }

    trigger.addEventListener("click", function () { populate(); dialog.showModal(); });
    document.getElementById("editor-close").addEventListener("click", function () { dialog.close(); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      editableKeys.forEach(function (key) { config[key] = form.elements[key].value.trim(); });
      window.localStorage.setItem(storageKey, JSON.stringify(config));
      applyConfig();
      loadRelease();
      dialog.close();
    });

    document.getElementById("editor-reset").addEventListener("click", function () {
      window.localStorage.removeItem(storageKey);
      config = Object.assign({}, defaultConfig);
      config.downloadOverrides = Object.assign({}, defaultConfig.downloadOverrides || {});
      populate();
      applyConfig();
      loadRelease();
    });

    document.getElementById("editor-export").addEventListener("click", function () {
      editableKeys.forEach(function (key) { config[key] = form.elements[key].value.trim(); });
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

  applyConfig();
  initializeEditor();
  loadRelease();
})();
