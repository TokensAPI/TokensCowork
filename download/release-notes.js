(function (root) {
  'use strict';
  function version(tag) {
    var match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(tag || '');
    return match ? { numbers: match.slice(1, 4).map(Number), suffix: match[4] || '' } : null;
  }
  // Return a positive number when a is a newer version than b.
  function compareVersions(a, b) {
    var left = version(a), right = version(b);
    if (!left || !right) return 0;
    for (var i = 0; i < 3; i++) {
      if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
    }
    if (!left.suffix || !right.suffix) return left.suffix ? -1 : right.suffix ? 1 : 0;
    var l = left.suffix.split('.'), r = right.suffix.split('.');
    for (var j = 0; j < Math.max(l.length, r.length); j++) {
      if (l[j] === undefined) return -1;
      if (r[j] === undefined) return 1;
      if (l[j] === r[j]) continue;
      var ln = /^\d+$/.test(l[j]), rn = /^\d+$/.test(r[j]);
      if (ln && rn) return Number(l[j]) - Number(r[j]);
      if (ln !== rn) return ln ? -1 : 1;
      return l[j] < r[j] ? -1 : 1;
    }
    return 0;
  }
  function selectLanguage(body, language) {
    var text = String(body || '').replace(/<!--[^]*?-->/g, '').replace(/<a (?:name|id)="release-notes-(?:zh|en)"><\/a>/g, '');
    var boundary = /^## What's New\s*$/m.exec(text);
    if (!boundary) return text; // Legacy monolingual notes remain readable.
    if (language === 'en') return text.slice(boundary.index);
    return text.slice(0, boundary.index)
      .replace(/^\[中文\]\([^\n]+\)\s*\|\s*\[English\]\([^\n]+\)\s*$/m, '')
      .replace(/\n---\s*$/, '').trim();
  }
  function introduction(body, language) {
    var lines = selectLanguage(body, language).split(/\r?\n/), paragraph = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { if (paragraph.length) break; continue; }
      if (!paragraph.length && (/^#\s/.test(line) || /^## What's New$/.test(line))) continue;
      if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|`{3}|>|\|)/.test(line)) break;
      paragraph.push(line);
    }
    return paragraph.join(' ').replace(/^(?:本次更新|本版本|本次发布)(?:[：:]\s*|\s*)/, '').trim();
  }
  var api = { compareVersions: compareVersions, selectLanguage: selectLanguage, introduction: introduction };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokensReleaseNotes = api;
})(typeof globalThis === 'object' ? globalThis : this);
