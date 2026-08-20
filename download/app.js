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
      stableLatestSuffix: "（稳定版 · 推荐 · 最新）",
      stableRecommendedSuffix: "（稳定版 · 推荐）",
      stableSuffix: "（稳定版）",
      latestSuffix: "（最新）",
      selectVersion: "选择下载版本",
      versionPanelTitle: "选择版本",
      searchVersions: "搜索版本",
      featuredVersions: "快捷选择",
      stableVersions: "稳定版本",
      allVersions: "其他版本",
      noMatchingVersion: "没有找到匹配的版本",
      versionsCount: "共 {count} 个版本",
      recommendedBadge: "推荐",
      stableBadge: "稳定版",
      latestBadge: "最新",
      loadingPage: "正在准备最新版本…",
      loadingVersion: "正在获取版本…",
      loadingDownload: "正在获取下载地址…",
      releaseUnavailable: "版本暂不可用",
      connectingRelease: "正在连接 GitHub Releases…",
      noRelease: "暂未读取到公开 Release，下载按钮将前往 GitHub",
      stableVersion: "稳定版 v{version} · {date}",
      latestVersion: "最新版本 v{version} · {date}",
      selectedVersion: "版本 v{version} · {date}",
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
      releaseChanges: "版本改动",
      releaseChangesSource: "内容来自 GitHub Release",
      noReleaseChanges: "该版本暂未提供更新说明",
      bundledPlugins: "内置插件",
      bundledPluginsSource: "随安装包内置，开箱即用",
      pluginHomepage: "GitHub 主页",
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
      stableLatestSuffix: " (Stable · Recommended · Latest)",
      stableRecommendedSuffix: " (Stable · Recommended)",
      stableSuffix: " (Stable)",
      latestSuffix: " (Latest)",
      selectVersion: "Choose download version",
      versionPanelTitle: "Choose a version",
      searchVersions: "Search versions",
      featuredVersions: "Quick access",
      stableVersions: "Stable versions",
      allVersions: "Other versions",
      noMatchingVersion: "No matching version found",
      versionsCount: "{count} versions",
      recommendedBadge: "Recommended",
      stableBadge: "Stable",
      latestBadge: "Latest",
      loadingPage: "Preparing the latest release…",
      loadingVersion: "Loading version…",
      loadingDownload: "Loading download…",
      releaseUnavailable: "Version unavailable",
      connectingRelease: "Connecting to GitHub Releases…",
      noRelease: "No public Release found. Download buttons will open GitHub.",
      stableVersion: "Stable v{version} · {date}",
      latestVersion: "Latest v{version} · {date}",
      selectedVersion: "Version v{version} · {date}",
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
      releaseChanges: "What's changed",
      releaseChangesSource: "From the GitHub Release",
      noReleaseChanges: "No release notes are available for this version.",
      bundledPlugins: "Bundled plugins",
      bundledPluginsSource: "Included in the installer, ready to use",
      pluginHomepage: "GitHub",
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
  var cachedReleases = [];
  var latestReleaseTag = "";
  var recommendedReleaseTag = "";
  var selectedReleaseTag = "";

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
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (element) {
      element.setAttribute("placeholder", translate(element.getAttribute("data-i18n-placeholder")));
    });
    document.querySelectorAll("[data-language]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-language") === currentLanguage));
    });
    populateReleaseSelector();
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

  function excludedReleaseHeading(value) {
    var heading = String(value || "")
      .replace(/[`*_~]/g, "")
      .replace(/^\s*[\d一二三四五六七八九十]+[.、：:]?\s*/, "")
      .trim()
      .toLowerCase();
    return heading === "验证结果" || heading === "已知限制" || heading === "完整变更" ||
      heading === "verification" || heading === "verification results" ||
      heading === "known limitation" || heading === "known limitations" ||
      heading === "full changes" || heading === "full changelog";
  }

  function visibleReleaseBody(markdown) {
    var skippedLevel = 0;
    return String(markdown || "").split(/\r?\n/).filter(function (line) {
      var heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        var level = heading[1].length;
        if (skippedLevel && level <= skippedLevel) skippedLevel = 0;
        if (excludedReleaseHeading(heading[2])) {
          skippedLevel = level;
          return false;
        }
      }
      return !skippedLevel;
    }).join("\n").trim();
  }

  function appendInlineMarkdown(container, value) {
    var source = String(value || "");
    var tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    var position = 0;
    var match;

    function appendText(text) {
      if (text) container.appendChild(document.createTextNode(text));
    }

    while ((match = tokenPattern.exec(source))) {
      appendText(source.slice(position, match.index));
      var token = match[0];
      if (token.charAt(0) === "`") {
        var code = document.createElement("code");
        code.textContent = token.slice(1, -1);
        container.appendChild(code);
      } else if (token.slice(0, 2) === "**") {
        var strong = document.createElement("strong");
        strong.textContent = token.slice(2, -2);
        container.appendChild(strong);
      } else {
        var linkParts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        var href = linkParts && linkParts[2];
        if (href && /^https?:\/\//i.test(href)) {
          var link = document.createElement("a");
          link.textContent = linkParts[1];
          link.href = href;
          link.target = "_blank";
          link.rel = "noreferrer";
          container.appendChild(link);
        } else {
          appendText(token);
        }
      }
      position = match.index + token.length;
    }
    appendText(source.slice(position));
  }

  function markdownCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (cell) {
      return cell.trim();
    });
  }

  function renderReleaseMarkdown(container, markdown) {
    container.innerHTML = "";
    var lines = String(markdown || "").split(/\r?\n/);
    var index = 0;
    while (index < lines.length) {
      var line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      if (/^\s*```/.test(line)) {
        var codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        var pre = document.createElement("pre");
        var blockCode = document.createElement("code");
        blockCode.textContent = codeLines.join("\n");
        pre.appendChild(blockCode);
        container.appendChild(pre);
        continue;
      }

      var heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        var headingLevel = Math.min(Number(heading[1].length) + 1, 6);
        var headingElement = document.createElement("h" + headingLevel);
        appendInlineMarkdown(headingElement, heading[2]);
        container.appendChild(headingElement);
        index += 1;
        continue;
      }

      if (index + 1 < lines.length && line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
        var table = document.createElement("table");
        var thead = document.createElement("thead");
        var headerRow = document.createElement("tr");
        markdownCells(line).forEach(function (cell) {
          var th = document.createElement("th");
          appendInlineMarkdown(th, cell);
          headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        index += 2;
        var tbody = document.createElement("tbody");
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
          var row = document.createElement("tr");
          markdownCells(lines[index]).forEach(function (cell) {
            var td = document.createElement("td");
            appendInlineMarkdown(td, cell);
            row.appendChild(td);
          });
          tbody.appendChild(row);
          index += 1;
        }
        table.appendChild(tbody);
        container.appendChild(table);
        continue;
      }

      var listMatch = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
      if (listMatch) {
        var ordered = Boolean(listMatch[2]);
        var list = document.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          var itemMatch = lines[index].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
          if (!itemMatch || Boolean(itemMatch[2]) !== ordered) break;
          var item = document.createElement("li");
          appendInlineMarkdown(item, itemMatch[3]);
          list.appendChild(item);
          index += 1;
        }
        container.appendChild(list);
        continue;
      }

      var quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        var blockquote = document.createElement("blockquote");
        appendInlineMarkdown(blockquote, quote[1]);
        container.appendChild(blockquote);
        index += 1;
        continue;
      }

      var paragraphLines = [line.trim()];
      index += 1;
      while (index < lines.length && lines[index].trim() &&
        !/^\s{0,3}#{1,6}\s+/.test(lines[index]) &&
        !/^\s*(?:[-+*]|\d+\.)\s+/.test(lines[index]) &&
        !/^\s*>/.test(lines[index]) &&
        !/^\s*```/.test(lines[index])) {
        paragraphLines.push(lines[index].trim());
        index += 1;
      }
      var paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, paragraphLines.join(" "));
      container.appendChild(paragraph);
    }
  }

  function renderReleaseChanges(release) {
    var section = document.getElementById("release-changes");
    var content = document.getElementById("release-changes-content");
    if (!section || !content) return;
    if (!release) {
      section.hidden = true;
      content.innerHTML = "";
      return;
    }
    var body = visibleReleaseBody(release.body);
    section.hidden = false;
    if (body) {
      renderReleaseMarkdown(content, body);
    } else {
      content.innerHTML = "";
      var empty = document.createElement("p");
      empty.className = "release-changes__empty";
      empty.textContent = translate("noReleaseChanges");
      content.appendChild(empty);
    }
  }

  var pluginManifestCache = {};

  // 内置插件清单来自该 Release 的 TokensHarness-<v>-plugins.json 资产
  // （发布工作流由 product.json 生成）。缺资产或拉取失败时隐藏整个区块。
  function renderBundledPlugins(release) {
    var section = document.getElementById("bundled-plugins");
    var grid = document.getElementById("bundled-plugins-grid");
    if (!section || !grid) return;
    section.hidden = true;
    grid.innerHTML = "";
    if (!release) return;
    var tag = release.tag_name;
    var asset = (release.assets || []).find(function (item) {
      return /-plugins\.json$/.test(item.name || "");
    });
    if (!asset) return;

    // Release 资产域不带 CORS 头，浏览器无法直接跨域读取；部署工作流已把
    // 各版本清单复制为站点内的 plugins/<tag>.json，优先同源读取，本地
    // file:// 预览等无站内副本的场景回退 API 资产端点（重定向域仍可能被
    // 浏览器拦截，届时隐藏区块）。
    var cached = pluginManifestCache[tag];
    var manifestPromise = cached || fetch("plugins/" + tag + ".json", { cache: "no-cache" })
      .then(function (response) {
        if (response.ok) return response.json();
        return fetch(apiUrl("/releases/assets/" + asset.id), {
          headers: { Accept: "application/octet-stream" }
        }).then(function (fallback) {
          if (!fallback.ok) throw new Error("plugins manifest " + fallback.status);
          return fallback.json();
        });
      });
    pluginManifestCache[tag] = manifestPromise;

    manifestPromise.then(function (manifest) {
      if (selectedReleaseTag !== tag) return;
      var plugins = (manifest && manifest.plugins) || [];
      if (!plugins.length) return;
      grid.innerHTML = "";
      plugins.forEach(function (plugin) {
        var card = document.createElement("article");
        card.className = "plugin-card";
        var title = document.createElement("h3");
        title.textContent = plugin.name || plugin.id;
        var version = document.createElement("span");
        version.className = "plugin-card__version";
        version.textContent = "v" + (plugin.version || "");
        title.appendChild(version);
        var description = document.createElement("p");
        description.textContent = plugin.description || "";
        card.appendChild(title);
        card.appendChild(description);
        if (plugin.homepage) {
          var link = document.createElement("a");
          link.href = plugin.homepage;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = translate("pluginHomepage") + " →";
          card.appendChild(link);
        }
        grid.appendChild(card);
      });
      section.hidden = false;
    }).catch(function () {
      delete pluginManifestCache[tag];
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
    link.removeAttribute("aria-disabled");
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

  function configureRecommended(urls, fallback) {
    var platform = recommendedPlatform();
    var button = document.getElementById("recommended-download");
    var label = document.getElementById("recommended-label");
    var icon = document.getElementById("recommended-icon");
    fallback = fallback || githubUrl("/releases/latest");
    button.removeAttribute("aria-disabled");

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

  function disableDownloadLink(id) {
    var link = document.getElementById(id);
    link.removeAttribute("href");
    link.removeAttribute("download");
    link.setAttribute("aria-disabled", "true");
    link.title = translate("loadingDownload");
  }

  function clearReleasePanel() {
    ["release-featured", "release-stable-options", "release-options"].forEach(function (id) {
      var container = document.getElementById(id);
      if (container) container.innerHTML = "";
    });
    var search = document.getElementById("release-search");
    var count = document.getElementById("release-count");
    var empty = document.getElementById("release-empty");
    if (search) search.value = "";
    if (count) count.textContent = "";
    if (empty) empty.hidden = true;
  }

  function applyLoadingState() {
    ["recommended-download", "windows-download", "mac-arm64-download", "mac-amd64-download"].forEach(disableDownloadLink);
    document.getElementById("recommended-label").textContent = translate("loadingDownload");

    var select = document.getElementById("release-select");
    if (select) {
      select.innerHTML = "";
      var option = document.createElement("option");
      option.textContent = translate("loadingVersion");
      select.appendChild(option);
      select.disabled = true;
    }
    var trigger = document.getElementById("release-trigger");
    var current = document.getElementById("release-current");
    if (trigger) trigger.disabled = true;
    if (current) current.textContent = translate("loadingVersion");
    clearReleasePanel();
    document.getElementById("release-status").textContent = translate("connectingRelease");
    document.getElementById("release-notes-link").removeAttribute("href");
    document.getElementById("download-count").textContent = translate("releaseSource");
    renderReleaseChanges(null);
    renderBundledPlugins(null);
  }

  function applyFallback() {
    var fallback = githubUrl("/releases/latest");
    var overrides = config.downloadOverrides;
    setDownloadLink("windows-download", overrides.windows, fallback);
    setDownloadLink("mac-arm64-download", overrides.macArm64, fallback);
    setDownloadLink("mac-amd64-download", overrides.macAmd64, fallback);
    configureRecommended(overrides, fallback);
    var select = document.getElementById("release-select");
    if (select) {
      select.innerHTML = "";
      var option = document.createElement("option");
      option.textContent = translate("releaseUnavailable");
      select.appendChild(option);
      select.disabled = true;
    }
    var trigger = document.getElementById("release-trigger");
    var current = document.getElementById("release-current");
    if (trigger) trigger.disabled = true;
    if (current) current.textContent = translate("releaseUnavailable");
    clearReleasePanel();
    document.getElementById("release-status").textContent = translate("noRelease");
    document.getElementById("release-notes-link").href = fallback;
    document.getElementById("download-count").textContent = translate("releaseSource");
    renderReleaseChanges(null);
    renderBundledPlugins(null);
  }

  function revealPage() {
    var loader = document.getElementById("page-loader");
    document.body.classList.remove("page-loading");
    if (!loader || loader.hidden) return;
    loader.classList.add("page-loader--done");
    window.setTimeout(function () { loader.hidden = true; }, 240);
  }

  function releaseVersion(release) {
    return (release.tag_name || config.fallbackVersion).replace(/^v/, "");
  }

  // 渠道以 GitHub Release 的 prerelease 元数据为唯一事实源：
  // 与 releases/latest 端点和应用内更新插件的判定口径保持一致。
  function isStableRelease(release) {
    return Boolean(release) && release.prerelease === false && release.draft !== true;
  }

  function appendReleaseBadge(container, text, modifier) {
    var badge = document.createElement("span");
    badge.className = "release-badge" + (modifier ? " release-badge--" + modifier : "");
    badge.textContent = text;
    container.appendChild(badge);
  }

  function createReleaseOption(release, featured) {
    var isRecommended = release.tag_name === recommendedReleaseTag;
    var isStable = isStableRelease(release);
    var isLatest = release.tag_name === latestReleaseTag;
    var option = document.createElement("button");
    option.type = "button";
    option.className = "release-option" + (featured ? " release-option--featured" : "");
    option.setAttribute("role", "option");
    option.setAttribute("data-release-tag", release.tag_name);
    option.setAttribute("data-release-search", release.tag_name.toLowerCase());
    option.setAttribute("aria-selected", String(release.tag_name === selectedReleaseTag));

    var copy = document.createElement("span");
    copy.className = "release-option__copy";
    var tag = document.createElement("strong");
    tag.textContent = release.tag_name;
    var date = document.createElement("small");
    date.textContent = formatDate(release.published_at);
    copy.appendChild(tag);
    copy.appendChild(date);
    option.appendChild(copy);

    var badges = document.createElement("span");
    badges.className = "release-option__badges";
    if (isStable) appendReleaseBadge(badges, translate("stableBadge"), "stable");
    if (isRecommended) appendReleaseBadge(badges, translate("recommendedBadge"), "stable");
    if (isLatest) appendReleaseBadge(badges, translate("latestBadge"), "latest");
    option.appendChild(badges);
    return option;
  }

  function filterReleaseOptions(query) {
    var normalized = String(query || "").trim().toLowerCase();
    var visibleCount = 0;
    document.querySelectorAll("#release-menu .release-option").forEach(function (option) {
      var visible = !normalized || option.getAttribute("data-release-search").includes(normalized);
      option.hidden = !visible;
      option.style.display = visible ? "" : "none";
      if (visible) visibleCount += 1;
    });
    [
      ["release-featured-section", "release-featured"],
      ["release-stable-section", "release-stable-options"],
      ["release-history-section", "release-options"]
    ].forEach(function (ids) {
      var section = document.getElementById(ids[0]);
      var container = document.getElementById(ids[1]);
      if (section && container) section.hidden = !container.querySelector(".release-option:not([hidden])");
    });
    document.getElementById("release-empty").hidden = visibleCount > 0;
  }

  function populateReleaseSelector() {
    var select = document.getElementById("release-select");
    var trigger = document.getElementById("release-trigger");
    var current = document.getElementById("release-current");
    var menu = document.getElementById("release-menu");
    var featured = document.getElementById("release-featured");
    var stableOptions = document.getElementById("release-stable-options");
    var options = document.getElementById("release-options");
    if (!select || !trigger || !current || !menu || !featured || !stableOptions || !options || !cachedReleases.length) return;

    select.innerHTML = "";
    cachedReleases.forEach(function (release) {
      var isRecommended = release.tag_name === recommendedReleaseTag;
      var isStable = isStableRelease(release);
      var isLatest = release.tag_name === latestReleaseTag;
      var suffix = "";
      if (isRecommended && isLatest) suffix = translate("stableLatestSuffix");
      else if (isRecommended) suffix = translate("stableRecommendedSuffix");
      else if (isStable) suffix = translate("stableSuffix");
      else if (isLatest) suffix = translate("latestSuffix");
      var label = release.tag_name + suffix;
      var option = document.createElement("option");
      option.value = release.tag_name;
      option.textContent = label;
      select.appendChild(option);
    });

    clearReleasePanel();
    var featuredTags = [recommendedReleaseTag];
    if (latestReleaseTag !== recommendedReleaseTag) featuredTags.push(latestReleaseTag);
    featuredTags.forEach(function (tag) {
      var release = cachedReleases.find(function (item) { return item.tag_name === tag; });
      if (release) featured.appendChild(createReleaseOption(release, true));
    });
    cachedReleases.filter(function (release) {
      return !featuredTags.includes(release.tag_name) && isStableRelease(release);
    }).forEach(function (release) {
      stableOptions.appendChild(createReleaseOption(release, false));
    });
    cachedReleases.filter(function (release) {
      return !featuredTags.includes(release.tag_name) && !isStableRelease(release);
    }).forEach(function (release) {
      options.appendChild(createReleaseOption(release, false));
    });

    document.getElementById("release-count").textContent = translate("versionsCount", { count: cachedReleases.length });
    filterReleaseOptions("");
    select.value = selectedReleaseTag || recommendedReleaseTag;
    select.disabled = cachedReleases.length < 2;
    trigger.disabled = cachedReleases.length < 2;
    current.textContent = select.options[select.selectedIndex].textContent;
  }

  function renderRelease(release) {
    if (!release) return;
    var assets = resolveAssets(release);
    var isStable = isStableRelease(release);
    var overrides = release.tag_name === recommendedReleaseTag ? config.downloadOverrides : {};
    var urls = {
      windows: overrides.windows || (assets.windows && assets.windows.browser_download_url),
      macArm64: overrides.macArm64 || (assets.macArm64 && assets.macArm64.browser_download_url),
      macAmd64: overrides.macAmd64 || (assets.macAmd64 && assets.macAmd64.browser_download_url)
    };
    var fallback = release.html_url || githubUrl("/releases/tag/" + release.tag_name);
    var totalDownloads = totalInstallerDownloads(cachedReleases);

    setDownloadLink("windows-download", urls.windows, fallback, assets.windows);
    setDownloadLink("mac-arm64-download", urls.macArm64, fallback, assets.macArm64);
    setDownloadLink("mac-amd64-download", urls.macAmd64, fallback, assets.macAmd64);
    configureRecommended(urls, fallback);

    var version = releaseVersion(release);
    var legacyVersion = document.getElementById("header-version");
    if (legacyVersion) legacyVersion.textContent = "v" + version;
    var statusKey = isStable ? "stableVersion" : (release.tag_name === latestReleaseTag ? "latestVersion" : "selectedVersion");
    document.getElementById("release-status").textContent = translate(statusKey, {
      version: version,
      date: formatDate(release.published_at)
    });
    document.getElementById("release-notes-link").href = fallback;
    document.getElementById("release-changes-link").href = fallback;
    renderReleaseChanges(release);
    renderBundledPlugins(release);
    document.getElementById("download-count").textContent = totalDownloads
      ? translate("totalDownloads", { count: formatCount(totalDownloads) })
      : translate("releaseSource");
  }

  function publishedReleases(releases) {
    return (Array.isArray(releases) ? releases : []).filter(function (item) {
      return item && !item.draft;
    }).sort(function (left, right) {
      return new Date(right.published_at || right.created_at) - new Date(left.published_at || left.created_at);
    });
  }

  async function fetchReleaseList(preferLive) {
    if (!preferLive) {
      try {
        var manifestResponse = await fetch("releases.json", { cache: "no-cache" });
        if (manifestResponse.ok) {
          var manifestReleases = publishedReleases(await manifestResponse.json());
          if (manifestReleases.length) return manifestReleases;
        }
      } catch (_error) {
        // Local file previews cannot read the deployed manifest; use GitHub below.
      }
    }

    var apiPath = "/releases?per_page=100" + (preferLive ? "&ts=" + Date.now() : "");
    var apiResponse = await fetch(apiUrl(apiPath), {
      cache: preferLive ? "no-store" : "default",
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!apiResponse.ok) throw new Error("No public release list");

    var apiReleases = publishedReleases(await apiResponse.json());
    if (!apiReleases.length) throw new Error("No public release");
    return apiReleases;
  }

  async function loadRelease() {
    applyLoadingState();
    try {
      cachedReleases = await fetchReleaseList();
      latestReleaseTag = cachedReleases[0].tag_name;
      var recommendedRelease = cachedReleases.find(isStableRelease) || cachedReleases[0];
      recommendedReleaseTag = recommendedRelease.tag_name;
      if (!selectedReleaseTag || !cachedReleases.some(function (item) { return item.tag_name === selectedReleaseTag; })) {
        selectedReleaseTag = recommendedReleaseTag;
      }
      populateReleaseSelector();
      renderRelease(cachedReleases.find(function (item) { return item.tag_name === selectedReleaseTag; }));
    } catch (_error) {
      applyFallback();
    } finally {
      revealPage();
    }
  }

  async function refreshDownloadCount() {
    try {
      var releases = await fetchReleaseList(true);
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

  function initializeReleaseSelector() {
    var select = document.getElementById("release-select");
    var picker = document.getElementById("release-picker");
    var trigger = document.getElementById("release-trigger");
    var menu = document.getElementById("release-menu");
    var search = document.getElementById("release-search");
    if (!select || !picker || !trigger || !menu || !search) return;

    function closeMenu() {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      search.value = "";
      filterReleaseOptions("");
    }

    select.addEventListener("change", function (event) {
      selectedReleaseTag = event.target.value;
      populateReleaseSelector();
      renderRelease(cachedReleases.find(function (release) { return release.tag_name === selectedReleaseTag; }));
    });
    trigger.addEventListener("click", function () {
      var opening = menu.hidden;
      menu.hidden = !opening;
      trigger.setAttribute("aria-expanded", String(opening));
      if (opening) {
        search.focus();
      }
    });
    search.addEventListener("input", function () {
      filterReleaseOptions(search.value);
    });
    search.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowDown") return;
      var firstOption = menu.querySelector(".release-option:not([hidden])");
      if (firstOption) {
        event.preventDefault();
        firstOption.focus();
      }
    });
    menu.addEventListener("click", function (event) {
      var option = event.target.closest("[data-release-tag]");
      if (!option) return;
      selectedReleaseTag = option.getAttribute("data-release-tag");
      populateReleaseSelector();
      renderRelease(cachedReleases.find(function (release) { return release.tag_name === selectedReleaseTag; }));
      closeMenu();
      trigger.focus();
    });
    document.addEventListener("click", function (event) {
      if (!picker.contains(event.target)) closeMenu();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !menu.hidden) {
        closeMenu();
        trigger.focus();
      }
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
        if (cachedReleases.length) {
          renderRelease(cachedReleases.find(function (release) { return release.tag_name === selectedReleaseTag; }));
        } else {
          loadRelease();
        }
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
  initializeReleaseSelector();
  initializeDownloadCountRefresh();
  applyConfig();
  initializeEditor();
  loadRelease();
})();
