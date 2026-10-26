import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { brandTurnStatusCopy } from './turn-status-copy-overlay.mjs'

// installed 阶段就地改写已安装的包，所以 staging 里那份可能已经打过补丁；先按同一份
// 映射还原成未加工的上游，测试的输入才是固定的（没装配过时用逐字相同的语言表片段）。
const installed = resolve(import.meta.dirname, '../../../.build/desktop/dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js')
const FALLBACK = `\t\t\t"chat.toBottom": "回到底部",
\t\t\t"chat.deepDiving": "深度求索中",
\t\t\t"chat.deepDivingFor": "深度求索中，用时 {duration} ···",
\t\t\t"chat.turnNavigation.label": "轮次导航",
\t\t\t"chat.toBottom": "Back to bottom",
\t\t\t"chat.deepDiving": "Deep diving",
\t\t\t"chat.deepDivingFor": "Deep diving for {duration} ···",
`
const upstream = (existsSync(installed) ? readFileSync(installed, 'utf8') : FALLBACK)
  .replace('"chat.deepDiving": "正在思考中"', '"chat.deepDiving": "深度求索中"')
  .replace('"chat.deepDivingFor": "正在思考中，用时 {duration} ···"', '"chat.deepDivingFor": "深度求索中，用时 {duration} ···"')
  .replace('"chat.deepDiving": "Thinking"', '"chat.deepDiving": "Deep diving"')
  .replace('"chat.deepDivingFor": "Thinking for {duration} ···"', '"chat.deepDivingFor": "Deep diving for {duration} ···"')

test('all four running-status strings carry product copy, keys untouched', () => {
  // 还原出来的输入必须确实是上游那四条，否则后面的断言都在空转。
  for (const anchor of ['"chat.deepDiving": "深度求索中"', '"chat.deepDivingFor": "深度求索中，用时 {duration} ···"',
    '"chat.deepDiving": "Deep diving"', '"chat.deepDivingFor": "Deep diving for {duration} ···"']) {
    assert.ok(upstream.includes(anchor), `输入里缺少上游锚点：${anchor}`)
  }
  const patched = brandTurnStatusCopy(upstream)
  assert.equal(brandTurnStatusCopy(patched), patched, '幂等：installed 阶段会重复执行')
  for (const gone of ['深度求索中', 'Deep diving']) assert.ok(!patched.includes(gone), `${gone} 仍在`)
  assert.ok(patched.includes('"chat.deepDiving": "正在思考中"'))
  assert.ok(patched.includes('"chat.deepDivingFor": "正在思考中，用时 {duration} ···"'))
  assert.ok(patched.includes('"chat.deepDiving": "Thinking"'))
  assert.ok(patched.includes('"chat.deepDivingFor": "Thinking for {duration} ···"'))
  // 其余条目一个字都不动：把这四处换回去就应当逐字还原上游。
  const restored = patched
    .replace('"chat.deepDiving": "正在思考中"', '"chat.deepDiving": "深度求索中"')
    .replace('"chat.deepDivingFor": "正在思考中，用时 {duration} ···"', '"chat.deepDivingFor": "深度求索中，用时 {duration} ···"')
    .replace('"chat.deepDiving": "Thinking"', '"chat.deepDiving": "Deep diving"')
    .replace('"chat.deepDivingFor": "Thinking for {duration} ···"', '"chat.deepDivingFor": "Deep diving for {duration} ···"')
  assert.equal(restored, upstream, '除这四条外不应有任何改动')
})

test('a drifted upstream string fails loudly instead of leaving the upstream brand', () => {
  assert.throws(() => brandTurnStatusCopy(upstream.replace('"chat.deepDiving": "Deep diving"', '"chat.deepDiving": "Diving"')),
    /turn-status-copy/)
})
