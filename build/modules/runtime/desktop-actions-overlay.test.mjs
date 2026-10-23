import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { keepRestartRequestable } from './desktop-actions-overlay.mjs'

// 以固定的上游源码为输入；只把 cordis 的 Service 基类换成空壳，其余原样加载执行。
const root = resolve(import.meta.dirname, '../../..')
const source = readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/src/desktop-actions.ts'), 'utf8')

async function loadService(text) {
  const stubbed = text.replace(/import \{[^}]*Service[^}]*\} from '@deepseek-ai\/cordis'\n/, 'class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }\n')
  assert.notEqual(stubbed, text, 'the upstream file must import Service from cordis')
  const dir = mkdtempSync(join(tmpdir(), 'desktop-actions-overlay-'))
  const file = join(dir, 'desktop-actions.mjs')
  // 上游构造函数用了 TS 参数属性（private readonly bootstrap），strip 模式不认，要 transform。
  writeFileSync(file, stripTypeScriptTypes(stubbed, { mode: 'transform' }))
  return (await import(pathToFileURL(file).href)).DesktopActionsService
}

const ctx = { effect() {} }

test('upstream latches after a cancelled confirmation; the overlay lets the next click ask again', async () => {
  const Upstream = await loadService(source)
  let asked = 0
  const bootstrap = { openTerminal() {}, requestRestart: async () => { asked += 1 } }  // 取消确认框：正常返回但没有重启
  const upstream = new Upstream(ctx, bootstrap)
  await upstream.requestRestart()
  await upstream.requestRestart()
  assert.equal(asked, 1, '上游：取消一次后第二次点击不再弹框')

  const patched = keepRestartRequestable(source)
  assert.equal(keepRestartRequestable(patched), patched, '幂等')
  assert.doesNotMatch(patched, /restartCompleted/)
  const Patched = await loadService(patched)
  asked = 0
  const service = new Patched(ctx, bootstrap)
  await service.requestRestart()
  await service.requestRestart()
  assert.equal(asked, 2, '覆盖后：每次点击都重新弹框')
})

test('in-flight requests are still deduplicated and failures still clear the slot', async () => {
  const Patched = await loadService(keepRestartRequestable(source))
  let release
  let asked = 0
  const service = new Patched(ctx, { openTerminal() {}, requestRestart: () => { asked += 1; return new Promise(resolve => { release = resolve }) } })
  const first = service.requestRestart()
  const second = service.requestRestart()
  assert.equal(first, second, '进行中的请求复用同一个 Promise')
  release()
  await first
  assert.equal(asked, 1)
  void service.requestRestart()
  assert.equal(asked, 2, '上一个结束后可以再发起')

  const failing = new Patched(ctx, { openTerminal() {}, requestRestart: async () => { throw new Error('dialog failed') } })
  await assert.rejects(failing.requestRestart(), /dialog failed/)
  await assert.rejects(failing.requestRestart(), /dialog failed/, '失败后也清槽，再次调用会重试')
})

test('a drifted upstream anchor fails loudly instead of silently skipping', () => {
  assert.throws(() => keepRestartRequestable(source.replace('private restartCompleted = false', 'private done = false')), /restart-requestable/)
})
