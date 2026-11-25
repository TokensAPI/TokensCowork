import { invalid } from './plugins.js'

/**
 * What the console shows about an app version, read from the GitHub release list
 * (releases.json, a snapshot of GitHub Releases that the download page publishes): whether it is a
 * pre-release, when it was published, the one-line summary, the 「本次更新」 points, the bundled
 * components and the installers. Read-only; the market stores none of it. Release notes are
 * Markdown and are only ever reduced to plain text here -- nothing is rendered.
 *
 * A successful read is kept for five minutes per environment; a failed one is not kept.
 */
export const APP_RELEASES_URL = 'https://tokensapi.github.io/TokensCowork/releases.json'
const CACHE_MS = 5 * 60_000
const RELEASE = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/u
const MAX_TEXT = 500
const MAX_SECTIONS = 10
const MAX_POINTS = 60
const MAX_COMPONENTS = 40
const GITHUB = /^https:\/\/github\.com\//u
const lists = new WeakMap()

/** The release list as GitHub publishes it; a 503 when it cannot be read. `fresh` skips the cache (and refills it). */
export async function releaseList(env, { fresh = false } = {}) {
  const cached = lists.get(env)
  if (!fresh && cached && cached.expires > Date.now()) return cached.list
  let list
  try {
    const response = await fetch(APP_RELEASES_URL, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    list = await response.json()
    if (!Array.isArray(list)) throw new Error('not a list')
  } catch {
    throw invalid('GitHub 发布列表暂时读不到', 503)
  }
  lists.set(env, { list, expires: Date.now() + CACHE_MS })
  return list
}

/** The published entry of a stable version x.y.z (tag v<version>), or null. */
export function releaseEntry(list, version) {
  return list.find(entry => entry && !entry.draft && typeof entry.tag_name === 'string' && entry.tag_name.replace(/^v/u, '') === version) ?? null
}
export const releaseVersion = entry =>
  entry && !entry.draft && typeof entry.tag_name === 'string' && RELEASE.test(entry.tag_name.replace(/^v/u, '')) ? entry.tag_name.replace(/^v/u, '') : null

// Markdown inline syntax reduced to its text: links and images to their label, code and emphasis
// to their content, HTML tags dropped, whitespace collapsed.
export function plainText(markdown) {
  return String(markdown)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/gu, '$1$2')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_TEXT)
}

// The notes' lines up to the English half: the bilingual notes put the Chinese first and mark the
// English with an anchor <a name="release-notes-en"> and an `## What's New` heading (the language
// switch above the Chinese links to that anchor too, so only the anchor itself counts).
function chineseLines(body) {
  const lines = String(body ?? '').split(/\r?\n/u)
  const end = lines.findIndex(line => /^\s*<a\s+name=["']?release-notes-en|^\s*##\s+What's New/iu.test(line))
  return end === -1 ? lines : lines.slice(0, end)
}

/** The first paragraph under the title: the release's one-line summary ('' when there is none). */
export function releaseSummary(body) {
  const paragraph = []
  for (const line of chineseLines(body)) {
    const text = line.trim()
    if (!text) {
      if (paragraph.length) break
      continue
    }
    if (/^#\s/u.test(text) && !paragraph.length) continue
    // A heading, a list, a table, an anchor or the language switch ends the search.
    if (/^(#|[-*+]\s|\d+\.\s|\||<a\s|\[中文\])/u.test(text)) break
    paragraph.push(text)
  }
  return plainText(paragraph.join(' '))
}

/**
 * The points under 「## 本次更新」, in their order: each `### 小节` with its `- 条目`; points before the
 * first sub-heading (older notes have none) form a section without a title.
 */
export function releaseHighlights(body) {
  const sections = []
  let inside = false, current = null, count = 0
  for (const line of chineseLines(body)) {
    const text = line.trim()
    if (/^##\s/u.test(text)) {
      inside = /^##\s+本次更新\s*$/u.test(text)
      current = null
      continue
    }
    if (!inside) continue
    if (/^###\s/u.test(text)) {
      // The components table has a heading of its own inside 本次更新; it is not a point.
      if (/^###\s+内置组件/u.test(text)) { current = null; inside = false; continue }
      current = { title: plainText(text.replace(/^###\s+/u, '')), items: [] }
      if (sections.length < MAX_SECTIONS) sections.push(current)
      continue
    }
    const point = /^[-*+]\s+(.+)$/u.exec(text)
    if (!point || count >= MAX_POINTS) continue
    if (!current) {
      current = { title: '', items: [] }
      sections.push(current)
    }
    const item = plainText(point[1])
    if (item) {
      current.items.push(item)
      count++
    }
  }
  return sections.filter(section => section.items.length)
}

/** The 「内置组件与插件」 table: [{ name, version }]. */
export function releaseComponents(body) {
  const rows = []
  let inside = false
  for (const line of chineseLines(body)) {
    const text = line.trim()
    if (/^#{2,3}\s/u.test(text)) {
      inside = /^#{2,3}\s+内置组件/u.test(text)
      continue
    }
    if (!inside || !text.startsWith('|')) continue
    const cells = text.replace(/^\||\|$/gu, '').split('|').map(cell => plainText(cell))
    if (cells.length < 2 || cells.every(cell => /^:?-+:?$/u.test(cell)) || (cells[0] === '组件' && cells[1] === '版本')) continue
    if (cells[0] && cells[1] && rows.length < MAX_COMPONENTS) rows.push({ name: cells[0], version: cells[1] })
  }
  return rows
}

/** The installers attached to the release (checksums and manifests left out). */
export function releaseInstallers(entry) {
  return (Array.isArray(entry?.assets) ? entry.assets : [])
    .filter(asset => asset && typeof asset.name === 'string' && !/\.(?:txt|json|sig|asc|sha256)$/iu.test(asset.name))
    .map(asset => ({
      name: asset.name.slice(0, 200),
      size: Number.isSafeInteger(asset.size) ? asset.size : null,
      url: typeof asset.browser_download_url === 'string' && GITHUB.test(asset.browser_download_url) ? asset.browser_download_url : null,
    }))
    .slice(0, 20)
}

const publishedAt = entry => (typeof entry.published_at === 'string' ? entry.published_at : null)

/** One line per published stable-format version, newest list order kept: for the list of rollouts. */
export function briefInfo(entry) {
  return { version: releaseVersion(entry), prerelease: entry.prerelease === true, publishedAt: publishedAt(entry), summary: releaseSummary(entry.body) }
}

/** Everything the detail page shows about one version. */
export function fullInfo(entry) {
  return {
    ...briefInfo(entry),
    name: typeof entry.name === 'string' ? plainText(entry.name) : '',
    url: typeof entry.html_url === 'string' && GITHUB.test(entry.html_url) ? entry.html_url : null,
    highlights: releaseHighlights(entry.body),
    components: releaseComponents(entry.body),
    installers: releaseInstallers(entry),
  }
}
