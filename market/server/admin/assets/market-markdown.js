/**
 * A small Markdown subset for model answers in the session-log console: headings, paragraphs,
 * lists (nested), block quotes, fenced code, rules, tables, and inline code / bold / italic /
 * strikethrough / links. Raw HTML is never interpreted — it stays visible text — and the DOM is
 * built with createElement/createTextNode only, so a model answer cannot inject markup or script.
 * Links keep only http(s) and mailto targets and open with rel="noopener noreferrer"; images are
 * shown as links, never loaded. Parsing (`parseMarkdown`) has no DOM, so it is tested on its own.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/u
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u
const QUOTE = /^ {0,3}> ?/u
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/u
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u
const blank = line => !line.trim()

/** Only these link targets are kept; anything else (javascript:, data:, relative) renders as text. */
export function safeHref(url) {
  const value = String(url ?? '').trim()
  if (!/^(https?:\/\/|mailto:)/iu.test(value)) return null
  // Control characters and whitespace have no place in a URL and are how filters get split.
  if (/[\u0000- \u007f]/u.test(value)) return null
  return value
}

/** Markdown text → a list of blocks (headings, paragraphs, lists, quotes, code, rules, tables). */
export function parseMarkdown(text) {
  return blocks(String(text ?? '').replace(/\r\n?/gu, '\n').split('\n'))
}

const startsBlock = line => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line)

function blocks(lines) {
  const out = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (blank(line)) { index++; continue }
    let match
    if ((match = FENCE.exec(line))) {
      const marker = match[1]
      const body = []
      index++
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`, 'u').test(lines[index])) body.push(lines[index++])
      index++
      out.push({ type: 'code', lang: match[2].replace(/[^\w+-]/gu, ''), text: body.join('\n') })
      continue
    }
    if ((match = HEADING.exec(line))) {
      out.push({ type: 'heading', level: match[1].length, inline: inline((match[2] ?? '').replace(/[ \t]+#+$/u, '')) })
      index++
      continue
    }
    if (RULE.test(line)) { out.push({ type: 'rule' }); index++; continue }
    if (QUOTE.test(line)) {
      const body = []
      while (index < lines.length && QUOTE.test(lines[index])) body.push(lines[index++].replace(QUOTE, ''))
      out.push({ type: 'quote', blocks: blocks(body) })
      continue
    }
    if (LIST.test(line)) { index = list(lines, index, out); continue }
    if (line.includes('|') && index + 1 < lines.length && lines[index + 1].includes('|') && TABLE_DELIMITER.test(lines[index + 1])) {
      const cells = row => row.trim().replace(/^\|/u, '').replace(/(?<!\\)\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim().replace(/\\\|/gu, '|'))
      const head = cells(line)
      const align = cells(lines[index + 1]).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : ''))
      index += 2
      const rows = []
      while (index < lines.length && !blank(lines[index]) && lines[index].includes('|')) rows.push(cells(lines[index++]))
      out.push({ type: 'table', align: head.map((_, column) => align[column] ?? ''),
        head: head.map(inline), rows: rows.map(row => head.map((_, column) => inline(row[column] ?? ''))) })
      continue
    }
    const body = [line]
    index++
    while (index < lines.length && !blank(lines[index]) && !startsBlock(lines[index])) body.push(lines[index++])
    out.push({ type: 'paragraph', inline: inline(body.map(part => part.trim()).join('\n')) })
  }
  return out
}

// One list (bullet or ordered) starting at `start`; items may hold nested blocks indented under them.
function list(lines, start, out) {
  const first = LIST.exec(lines[start])
  const ordered = /\d/u.test(first[2])
  const base = first[1].length
  const items = []
  let index = start
  let width = 0
  let body = null
  let previousBlank = false
  while (index < lines.length) {
    const line = lines[index]
    const match = LIST.exec(line)
    if (match && match[1].length === base && /\d/u.test(match[2]) === ordered) {
      body = [match[4]]
      items.push(body)
      width = base + match[2].length + Math.max(1, Math.min(match[3].length, 4))
      previousBlank = false
      index++
      continue
    }
    if (blank(line)) { body.push(''); previousBlank = true; index++; continue }
    const indent = line.match(/^ */u)[0].length
    if (indent >= Math.min(width, base + 2)) { body.push(line.slice(Math.min(indent, width))); previousBlank = false; index++; continue }
    // A non-indented line right after item text continues that paragraph (lazy continuation).
    if (!previousBlank && !startsBlock(line)) { body.push(line.trim()); index++; continue }
    break
  }
  while (items.length && blank(items.at(-1).at(-1) ?? 'x')) items.at(-1).pop()
  out.push({ type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: items.map(blocks) })
  return index
}

/** Inline text → a list of nodes: text, br, code, strong, em, del, link. */
export function inline(text, links = true) {
  const out = []
  let buffer = ''
  const flush = () => { if (buffer) { out.push({ type: 'text', text: buffer }); buffer = '' } }
  const push = node => { flush(); out.push(node) }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const rest = text.slice(index)
    if (char === '\\' && /^\\[!-/:-@[-`{-~]/u.test(rest)) { buffer += text[index + 1]; index += 2; continue }
    if (char === '\n') { push({ type: 'br' }); index++; continue }
    if (char === '`') {
      const run = rest.match(/^`+/u)[0]
      const close = text.indexOf(run, index + run.length)
      if (close !== -1 && text[close + run.length] !== '`') {
        let code = text.slice(index + run.length, close).replace(/\n/gu, ' ')
        if (/^ .*[^ ].* $/u.test(code)) code = code.slice(1, -1)
        push({ type: 'code', text: code })
        index = close + run.length
        continue
      }
      buffer += run
      index += run.length
      continue
    }
    if (links && char === '!' && text[index + 1] === '[') {
      const link = linkAt(text, index + 1)
      if (link) {
        const href = safeHref(link.url)
        const label = `[图片${link.label ? `：${link.label}` : ''}]`
        if (href) push({ type: 'link', href, children: [{ type: 'text', text: label }] })
        else buffer += label
        index = link.end
        continue
      }
    }
    if (links && char === '[') {
      const link = linkAt(text, index)
      if (link) {
        const href = safeHref(link.url)
        const children = inline(link.label, false)
        if (href) push({ type: 'link', href, children })
        else { flush(); out.push(...children) }
        index = link.end
        continue
      }
    }
    if (links && char === '<') {
      const auto = rest.match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/iu)
      if (auto && safeHref(auto[1])) { push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }] }); index += auto[0].length; continue }
    }
    if (links && (char === 'h' || char === 'H') && /[^\w/]$|^$/u.test(text.slice(Math.max(0, index - 1), index))) {
      const bare = rest.match(/^https?:\/\/[^\s<>]+/iu)
      if (bare) {
        // Trailing punctuation (and an unbalanced closing bracket) belongs to the sentence, not the URL.
        let url = bare[0].replace(/[.,;:!?'"。，；：！？、）】》]+$/u, '')
        while (url.endsWith(')') && (url.match(/\(/gu)?.length ?? 0) < (url.match(/\)/gu)?.length ?? 0)) url = url.slice(0, -1)
        if (safeHref(url)) { push({ type: 'link', href: url, children: [{ type: 'text', text: url }] }); index += url.length; continue }
      }
    }
    const emphasis = emphasisAt(text, index)
    if (emphasis) { push({ type: emphasis.type, children: inline(emphasis.inner, links) }); index = emphasis.end; continue }
    buffer += char
    index++
  }
  flush()
  return out
}

// `[label](url "title")` starting at `start`, or null.
function linkAt(text, start) {
  let depth = 0
  let close = -1
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue }
    if (text[index] === '[') depth++
    else if (text[index] === ']' && --depth === 0) { close = index; break }
  }
  if (close === -1 || text[close + 1] !== '(') return null
  const target = text.slice(close + 2).match(/^[ \t]*(?:<([^<>\n]*)>|((?:[^\s()]|\([^\s()]*\))*))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/u)
  if (!target) return null
  return { label: text.slice(start + 1, close), url: target[1] ?? target[2] ?? '', end: close + 2 + target[0].length }
}

// **strong**, __strong__, *em*, _em_, ~~del~~ at `index`, or null. Underscores inside words
// (snake_case) are left alone, and a delimiter must hug its text on both sides.
function emphasisAt(text, index) {
  for (const [marker, type] of [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']]) {
    if (!text.startsWith(marker, index)) continue
    const after = text[index + marker.length]
    if (!after || /\s/u.test(after) || (marker.length === 1 && after === marker)) continue
    if (marker[0] === '_' && /[\p{L}\p{N}]/u.test(text[index - 1] ?? '')) continue
    let close = index + marker.length
    while ((close = text.indexOf(marker, close + 1)) !== -1) {
      if (/\s/u.test(text[close - 1])) continue
      if (marker.length === 1 && (text[close + 1] === marker || text[close - 1] === marker)) continue
      if (marker[0] === '_' && /[\p{L}\p{N}]/u.test(text[close + marker.length] ?? '')) continue
      if (text.slice(index + marker.length, close).includes('\n\n')) return null
      return { type, inner: text.slice(index + marker.length, close), end: close + marker.length }
    }
  }
  return null
}

/** Markdown text → a DocumentFragment built from elements and text nodes only. */
export function renderMarkdown(text, doc = document) {
  const fragment = doc.createDocumentFragment()
  for (const block of parseMarkdown(text)) fragment.append(renderBlock(block, doc))
  return fragment
}

function element(doc, tag, children = [], className = '') {
  const node = doc.createElement(tag)
  if (className) node.className = className
  for (const child of children) node.append(child)
  return node
}

function renderBlock(block, doc) {
  switch (block.type) {
    case 'heading': return element(doc, `h${block.level}`, renderInline(block.inline, doc))
    case 'paragraph': return element(doc, 'p', renderInline(block.inline, doc))
    case 'rule': return element(doc, 'hr')
    case 'quote': return element(doc, 'blockquote', block.blocks.map(child => renderBlock(child, doc)))
    case 'code': {
      const code = element(doc, 'code', [doc.createTextNode(block.text)], block.lang ? `language-${block.lang}` : '')
      return element(doc, 'pre', [code])
    }
    case 'list': {
      const list = element(doc, block.ordered ? 'ol' : 'ul', block.items.map(item => {
        // A one-paragraph item is written inline; anything richer keeps its blocks.
        if (item.length === 1 && item[0].type === 'paragraph') return element(doc, 'li', renderInline(item[0].inline, doc))
        return element(doc, 'li', item.map(child => renderBlock(child, doc)))
      }))
      if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start))
      return list
    }
    case 'table': {
      const cell = (tag, nodes, column) => {
        const node = element(doc, tag, renderInline(nodes, doc))
        if (block.align[column]) node.className = `md-align-${block.align[column]}`
        return node
      }
      const head = element(doc, 'thead', [element(doc, 'tr', block.head.map((nodes, column) => cell('th', nodes, column)))])
      const body = element(doc, 'tbody', block.rows.map(row => element(doc, 'tr', row.map((nodes, column) => cell('td', nodes, column)))))
      return element(doc, 'div', [element(doc, 'table', [head, body])], 'md-table')
    }
  }
  return doc.createTextNode('')
}

function renderInline(nodes, doc) {
  return nodes.map(node => {
    switch (node.type) {
      case 'text': return doc.createTextNode(node.text)
      case 'br': return doc.createElement('br')
      case 'code': return element(doc, 'code', [doc.createTextNode(node.text)])
      case 'strong': case 'em': case 'del': return element(doc, node.type, renderInline(node.children, doc))
      case 'link': {
        const link = element(doc, 'a', renderInline(node.children, doc))
        link.setAttribute('href', node.href)
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener noreferrer')
        return link
      }
    }
    return doc.createTextNode('')
  })
}
