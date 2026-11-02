import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, inline, safeHref, renderMarkdown } from '../admin/assets/market-markdown.js'

// The session-log console renders model answers with this subset. A tiny stand-in document is
// enough to check the DOM it builds: only elements and text nodes, never parsed HTML.
function fakeDocument() {
  const element = tag => ({
    tag, className: '', attributes: {}, children: [],
    append(...nodes) { this.children.push(...nodes) },
    setAttribute(name, value) { this.attributes[name] = value },
  })
  return {
    createElement: element,
    createDocumentFragment: () => element('#fragment'),
    createTextNode: text => ({ tag: '#text', text }),
  }
}
const html = node => (node.tag === '#text' ? node.text.replace(/</gu, '&lt;')
  : node.tag === '#fragment' ? node.children.map(html).join('')
    : `<${node.tag}${node.className ? ` class="${node.className}"` : ''}${Object.entries(node.attributes).map(([name, value]) => ` ${name}="${value}"`).join('')}>${node.children.map(html).join('')}</${node.tag}>`)
const render = text => html(renderMarkdown(text, fakeDocument()))

test('headings, paragraphs, emphasis and inline code', () => {
  assert.equal(render('# 标题\n\n一段 **加粗**、*斜体*、~~删除~~ 和 `code`。'),
    '<h1>标题</h1><p>一段 <strong>加粗</strong>、<em>斜体</em>、<del>删除</del> 和 <code>code</code>。</p>')
  assert.equal(render('第一行\n第二行'), '<p>第一行<br></br>第二行</p>')
  // snake_case and a lone asterisk stay literal.
  assert.equal(render('read_file_now 和 2 * 3'), '<p>read_file_now 和 2 * 3</p>')
  assert.equal(render('\\*不是斜体\\*'), '<p>*不是斜体*</p>')
  assert.equal(render('## 带尾部井号 ##'), '<h2>带尾部井号</h2>')
})

test('lists nest by indentation and keep their start number', () => {
  assert.equal(render('- a\n- b\n  - c\n- d'), '<ul><li>a</li><li><p>b</p><ul><li>c</li></ul></li><li>d</li></ul>')
  assert.equal(render('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>')
  assert.equal(render('1. 跑：\n\n   ```sh\n   npm test\n   ```\n2. 完'),
    '<ol><li><p>跑：</p><pre><code class="language-sh">npm test</code></pre></li><li>完</li></ol>')
  assert.equal(render('- a\n\n段落'), '<ul><li>a</li></ul><p>段落</p>')
})

test('code blocks keep their text verbatim; quotes, rules and tables', () => {
  assert.equal(render('```js\nconst a = "<b>"\n  **x**\n```'), '<pre><code class="language-js">const a = "&lt;b>"\n  **x**</code></pre>')
  assert.equal(render('```\nunclosed'), '<pre><code>unclosed</code></pre>')
  assert.equal(render('> 引用 **重点**\n> 第二行'), '<blockquote><p>引用 <strong>重点</strong><br></br>第二行</p></blockquote>')
  assert.equal(render('---'), '<hr></hr>')
  assert.equal(render('| a | b |\n| :-- | --: |\n| `1` | 2 |'),
    '<div class="md-table"><table><thead><tr><th class="md-align-left">a</th><th class="md-align-right">b</th></tr></thead>'
    + '<tbody><tr><td class="md-align-left"><code>1</code></td><td class="md-align-right">2</td></tr></tbody></table></div>')
})

test('links open safely; unsafe targets and raw HTML stay text', () => {
  assert.equal(render('[文档](https://example.com/a_(b))'),
    '<p><a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">文档</a></p>')
  assert.equal(render('见 https://example.com/x。'),
    '<p>见 <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>。</p>')
  assert.equal(render('[点我](javascript:alert(1))'), '<p>点我</p>')
  assert.equal(render('[x](data:text/html,hi)'), '<p>x</p>')
  assert.equal(render('<script>alert(1)</script> <img src=x onerror=alert(1)>'),
    '<p>&lt;script>alert(1)&lt;/script> &lt;img src=x onerror=alert(1)></p>')
  // Images are links, never loaded.
  assert.equal(render('![图](https://example.com/i.png)'),
    '<p><a href="https://example.com/i.png" target="_blank" rel="noopener noreferrer">[图片：图]</a></p>')
  // A URL as a link label does not nest a second link.
  assert.equal(render('[https://a.example](https://a.example)'),
    '<p><a href="https://a.example" target="_blank" rel="noopener noreferrer">https://a.example</a></p>')
  assert.equal(safeHref('JAVASCRIPT:alert(1)'), null)
  assert.equal(safeHref('https://exa mple.com'), null)
  assert.equal(safeHref('mailto:a@example.com'), 'mailto:a@example.com')
})

test('the parser has no DOM and returns plain blocks', () => {
  assert.deepEqual(parseMarkdown('## T\n\n- a'), [
    { type: 'heading', level: 2, inline: [{ type: 'text', text: 'T' }] },
    { type: 'list', ordered: false, start: 1, items: [[{ type: 'paragraph', inline: [{ type: 'text', text: 'a' }] }]] },
  ])
  assert.deepEqual(inline('a `b` c'), [{ type: 'text', text: 'a ' }, { type: 'code', text: 'b' }, { type: 'text', text: ' c' }])
  assert.deepEqual(parseMarkdown(''), [])
})
