(function (root) {
  'use strict';
  // 内置插件清单（plugins/<tag>.json）只带中文 name / description。英文界面
  // 按插件 id 在页面侧补英文，所有历史版本的清单都能直接用，无需重新发布。
  var english = {
    'tokens-version-updates': {
      name: 'TokensCowork Updates',
      description: 'Checks TokensCowork GitHub Releases for product updates and downloads them, replacing the official DSH updater.'
    },
    'dsh-tokensapi-ui': {
      name: 'Tokens Cowork UI',
      description: 'Brand visuals, theme skins, skill shortcuts and sidebar extensions for Tokens Cowork.'
    },
    'tokens-login': {
      name: 'TokensAPI Account',
      description: 'Sign in to your TokensAPI account in your own browser and set up the account\'s API key for the model plugins to share.'
    },
    'tokens-model-manager': {
      name: 'TokensAPI Models',
      description: 'Manages your TokensAPI API key, main model and text-to-vision bridge in one place, and keeps the current session\'s model in sync.'
    },
    'tokens-dsh-web-search': {
      name: 'Web Search',
      description: 'Multi-engine web search with automatic fallback for the native web_search tool, with no extra API key.'
    },
    'tokens-loop-guard': {
      name: 'Loop Guard',
      description: 'Detects exact and near-duplicate tool calls, warns first and then blocks, replacing the upstream repeat-tool-reminder.'
    },
    'tokens-session-log': {
      name: 'Session Log Upload',
      description: 'Uploads session logs in the background to the TokensCowork service, separate from model requests; can be turned off in Settings.'
    }
  };

  // 英文界面取值顺序：清单自带的 nameEn / descriptionEn → 页面英文表 → 原中文。
  function pluginText(plugin, language) {
    plugin = plugin || {};
    var name = plugin.name || plugin.id || '';
    var description = plugin.description || '';
    if (language !== 'en') return { name: name, description: description };
    var fallback = Object.prototype.hasOwnProperty.call(english, plugin.id) ? english[plugin.id] : {};
    return {
      name: plugin.nameEn || fallback.name || name,
      description: plugin.descriptionEn || fallback.description || description
    };
  }

  var api = { pluginText: pluginText, english: english };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokensBundledPlugins = api;
})(typeof globalThis === 'object' ? globalThis : this);
