/* ====================================================================
 * 锚点工具
 * 覆盖函数用它们定位上游文本：锚点数量不对立即抛 AnchorError，由执行器
 * 补上覆盖 id 与目标文件后报告。替换文本按字面写入，不解析 $& 等模式。
 * ==================================================================== */

/** 锚点失配：上游内容与覆盖预期不一致，需要人工复查。 */
export class AnchorError extends Error {
  name = 'AnchorError'
}

const preview = text => {
  const line = String(text).split('\n').find(item => item.trim()) ?? String(text)
  return JSON.stringify(line.trim().length > 80 ? `${line.trim().slice(0, 77)}...` : line.trim())
}

/** 统计非重叠出现次数。 */
export function countOf(source, anchor) {
  return source.split(anchor).length - 1
}

/** 要求锚点恰好出现一次。 */
export function requireOnce(source, anchor, label = '上游内容') {
  const count = countOf(source, anchor)
  if (count !== 1) throw new AnchorError(`${label}：锚点应出现 1 次，实际 ${count} 次：${preview(anchor)}`)
}

/** 要求文本存在（可出现多次）。 */
export function requireText(source, text, label = '上游内容') {
  if (!source.includes(text)) throw new AnchorError(`${label}：锚点未找到：${preview(text)}`)
}

/** 锚点恰好一次时替换；替换文本按字面写入，不解析 $& 等模式。 */
export function replaceOnce(source, anchor, replacement, label) {
  requireOnce(source, anchor, label)
  return source.replace(anchor, () => replacement)
}

/** 在唯一锚点之后插入。 */
export function insertAfter(source, anchor, text, label) {
  return replaceOnce(source, anchor, anchor + text, label)
}

/** 在唯一锚点之前插入。 */
export function insertBefore(source, anchor, text, label) {
  return replaceOnce(source, anchor, text + anchor, label)
}

/** 正则恰好命中一次时替换。 */
export function replacePatternOnce(source, pattern, replacement, label = '上游内容') {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const count = [...source.matchAll(new RegExp(pattern.source, flags))].length
  if (count !== 1) throw new AnchorError(`${label}：锚点应命中 1 次，实际 ${count} 次：/${pattern.source.slice(0, 60)}/`)
  return source.replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement)
}
