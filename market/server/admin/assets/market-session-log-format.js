/**
 * The session-log list's wording, kept free of the DOM so the tests read it directly: what one
 * search box means, sizes, token counts, relative times, shortened Keys and platform names.
 */
const DAY = 24 * 60 * 60 * 1000

/** The time presets of the filter bar, as how far back from now they reach. */
export const TIME_PRESETS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }

/**
 * Which list filter one search text stands for. `session-…` is a session id, `sk-…` a Key, digits
 * alone a reported account id, and a run of hex digits (4-64) a Key fingerprint prefix, which the
 * Key filter also accepts. Anything else is taken as an account id, matched exactly.
 */
export function classifySearch(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  if (/^session-/iu.test(value)) return { field: 'session', value }
  if (/^sk-/iu.test(value)) return { field: 'key', value }
  if (/^[0-9]+$/u.test(value)) return { field: 'account', value }
  if (/^[a-f0-9]{4,64}$/iu.test(value)) return { field: 'key', value }
  return { field: 'account', value }
}

/** Bytes as KB / MB / GB; nothing is 0 KB, anything else at least 1 KB. */
export function sizeText(value) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${value ? Math.max(1, Math.round(value / 1024)) : 0} KB`
}

/** Token counts the way they are read in Chinese: 9,876 · 60.1 万 · 1.2 亿; none is 「—」. */
export function tokenText(value) {
  if (!value) return '—'
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)} 亿`
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)} 万`
  return value.toLocaleString('zh-CN')
}

const pad = (n) => String(n).padStart(2, '0')
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * 「刚刚」 · 「12 分钟前」 · 「3 小时前」 (today) · 「昨天 22:34」 · 「11月20日 08:15」 (this year) ·
 * 「2025/12/31」; a time ahead of the clock is shown as its date and time.
 */
export function relativeTime(value, now = Date.now()) {
  if (!value) return '—'
  const date = new Date(value), today = startOfDay(new Date(now)), ago = now - value
  if (ago >= 0 && ago < 60_000) return '刚刚'
  if (ago >= 0 && ago < 3_600_000) return `${Math.floor(ago / 60_000)} 分钟前`
  if (ago >= 0 && value >= today) return `${Math.floor(ago / 3_600_000)} 小时前`
  if (value >= today - DAY && value < today) return `昨天 ${clock(date)}`
  if (date.getFullYear() === new Date(now).getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/** A Key shortened to its first 7 and last 4 characters; a short one is shown whole. */
export function shortKey(key) {
  return key && key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : key ?? ''
}

/** The operating system as people name it; an unknown value is shown as reported. */
export function platformName(value) {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[value] ?? value ?? ''
}
