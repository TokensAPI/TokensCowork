/* ============================================================
 * 产品覆盖：运行状态文字使用产品措辞
 * ============================================================
 * 上游聊天包把一轮执行中的状态写成「深度求索中」/「Deep diving」（DeepSeek 自己的
 * 品牌说法）。Tokens Cowork UI 插件原本在渲染后按文字匹配替换，DSH 0.2.1 改了这两条
 * 文案（去掉省略号、加了「用时 {duration}」变体）之后就不再命中，产品里又出现了上游
 * 品牌（2026-10-26 用户真机：「深度求索中，用时 1分59秒」）。
 *
 * 这里直接改语言表，四条（中英各两条）一起换，命中不依赖渲染结果，也不依赖 UI 插件。
 * 每条锚点自带守护：上游改了文案或键名，装配立即失败而不是静默回到上游品牌。
 * ============================================================ */
import { replaceOnce } from '../../pipeline/anchors.mjs'

const LABEL = 'branding.turn-status-copy'

/** 上游文案 → 产品文案。键名不动，只换值。 */
const TURN_STATUS_COPY = [
  ['"chat.deepDiving": "深度求索中"', '"chat.deepDiving": "正在思考中"'],
  ['"chat.deepDivingFor": "深度求索中，用时 {duration} ···"', '"chat.deepDivingFor": "正在思考中，用时 {duration} ···"'],
  ['"chat.deepDiving": "Deep diving"', '"chat.deepDiving": "Thinking"'],
  ['"chat.deepDivingFor": "Deep diving for {duration} ···"', '"chat.deepDivingFor": "Thinking for {duration} ···"'],
]

/** 把聊天语言表里的运行状态文案换成产品措辞。 */
export function brandTurnStatusCopy(source) {
  if (source.includes('正在思考中')) return source
  let next = source
  for (const [anchor, replacement] of TURN_STATUS_COPY) next = replaceOnce(next, anchor, replacement, LABEL)
  return next
}
