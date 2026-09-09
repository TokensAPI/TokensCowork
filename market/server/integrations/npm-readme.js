// Extract a suggestion, not authoritative package metadata. Never render Markdown/HTML.
export function readmeSummary(readme) {
  if (typeof readme !== 'string') return ''
  const lines = readme.slice(0, 100000)
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/giu, '')
    .split(/\r?\n/u)
  const paragraph = []
  let fence = ''
  for (const raw of lines) {
    const line = raw.trim()
    const marker = /^(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) { if (!fence) fence = marker[0]; else if (fence === marker[0]) fence = ''; continue }
    if (fence) continue
    if (/^#{2,}\s/u.test(line)) break
    if (!line || /^#\s/u.test(line) || /^(?:>|[-*+]\s|\d+[.)]\s|\||<|\[[^\]]+\]:|[-=_]{3,}$)/u.test(line)) {
      if (paragraph.length) break
      continue
    }
    const clean = line
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/<[^>]*>/gu, '')
      .replace(/[*_`]/gu, '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
      .trim()
    if (clean) paragraph.push(clean)
  }
  return paragraph.join(' ').slice(0, 1000)
}
