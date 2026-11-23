/**
 * What an uploaded documentation page needs before it is saved, DOM-free so the tests read it
 * directly: the relative images it points at, the page with those pointed at their uploaded
 * addresses, and its title. Used by the console's plugin documentation page (pages/DocsPage.vue).
 */
// `![alt](target "title")`: the target as written, angle brackets included, and what follows it.
const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)((?:\s+"[^"\n]*")?\s*)\)/gu
// A target with a scheme, a root or only a fragment is not a file beside the page.
const relative = target => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(target)
const unwrap = target => target.replace(/^<(.*)>$/u, '$1')
/** The file a relative target names, compared case-blind: `./images/Step%201.png` → `step 1.png`. */
export function imageFileName(target) {
  const last = unwrap(target).split(/[?#]/u)[0].split('/').pop()
  try { return decodeURIComponent(last).toLowerCase() } catch { return last.toLowerCase() }
}

/** The relative images a page points at, each file once, in order: [{ target, name }]. */
export function imageReferences(text) {
  const seen = new Map()
  for (const [, , target] of String(text).matchAll(IMAGE)) {
    if (!relative(unwrap(target))) continue
    const name = imageFileName(target)
    if (name && !seen.has(name)) seen.set(name, { target: unwrap(target), name })
  }
  return [...seen.values()]
}

/** The page with every relative image whose file was uploaded pointed at its new address (`uploaded`: name → url). */
export function replaceImageReferences(text, uploaded) {
  return String(text).replace(IMAGE, (whole, alt, target, rest) => {
    if (!relative(unwrap(target))) return whole
    const url = uploaded.get(imageFileName(target))
    return url ? `![${alt}](${url}${rest})` : whole
  })
}

/** A page's title: the file's first level-one heading, else its file name without the extension. */
export function docTitle(text, fileName) {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/mu.exec(text)?.[1]?.trim()
  return (heading || fileName.replace(/\.(md|markdown|txt)$/iu, '') || '未命名文档').slice(0, 120)
}
