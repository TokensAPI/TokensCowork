import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { attachReleaseNotesToResult, showReleaseNotesInManualCheck } from './release-notes-dialog-overlay.mjs'

// 固定的上游与插件源码，不用夹具。
const root = resolve(import.meta.dirname, '../../..')
const host = readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/src/electron-runtime.ts'), 'utf8')
const plugin = readFileSync(resolve(root, 'plugins/tokens_DshVersionUpdates_code/index.js'), 'utf8')

test('the plugin hands the rendered notes to the host when it falls back', () => {
  // 上游原样：回退时只传结果，宿主拿不到任何发布说明。
  assert.match(plugin, /if \(electron === null\) return adapter\.showManualCheckResult\(result\)/)
  const patched = attachReleaseNotesToResult(plugin)
  assert.equal(attachReleaseNotesToResult(patched), patched, '幂等')
  assert.match(patched, /notesText = result === null/)
  assert.match(patched, /renderReleaseNotes\(result\.notes, ctx\.desktopRuntime\.locale\)/)
  // 没有正文时原样交回，不凭空造一个字段。
  assert.match(patched, /notesText === '' \? result : \{ \.\.\.result, notesText \}/)
  // 解析仍只有插件自带的那一份，覆盖不复制口径。
  assert.match(plugin, /import \{ renderReleaseNotes \} from '\.\/release-notes\.js'/)
})

test('the host dialog appends the notes it is given and is unchanged without them', async () => {
  const patched = showReleaseNotesInManualCheck(host)
  assert.equal(showReleaseNotesInManualCheck(patched), patched, '幂等')
  assert.match(patched, /private withReleaseNotes\(detail: string, result: UpdateCheckResult\): string/)
  // 两条结果路径都接上，失败路径（result === null）不碰。
  assert.match(patched, /detail: this\.withReleaseNotes\(copy\.installedVersion\(result\.currentVersion\), result\),/)
  assert.match(patched, /detail: this\.withReleaseNotes\(copy\.installerUnavailable, result\),/)
  assert.match(patched, /detail: copy\.tryAgainLater,/)

  // 真跑一遍注入的方法：有正文才接，空白与非字符串都按没有处理。
  const behaviour = patched.match(/private withReleaseNotes[\s\S]*?\n  \}/u)[0]
    .replace('private withReleaseNotes(detail: string, result: UpdateCheckResult): string', 'function withReleaseNotes(detail, result)')
    .replace(': string', '')
    .replace('(result as { readonly notesText?: unknown })', 'result')
  const { withReleaseNotes } = await import(`data:text/javascript,${encodeURIComponent(`${behaviour}\nexport { withReleaseNotes }`)}`)
  assert.equal(withReleaseNotes('当前版本：0.7.5', { notesText: '修了一个问题' }), '当前版本：0.7.5\n\n修了一个问题')
  assert.equal(withReleaseNotes('当前版本：0.7.5', {}), '当前版本：0.7.5')
  assert.equal(withReleaseNotes('当前版本：0.7.5', { notesText: '  ' }), '当前版本：0.7.5')
  assert.equal(withReleaseNotes('当前版本：0.7.5', { notesText: 42 }), '当前版本：0.7.5')
})

test('a drifted anchor fails loudly instead of silently leaving the dialog bare', () => {
  assert.throws(() => attachReleaseNotesToResult(plugin.replace('adapter.showManualCheckResult(result)', 'adapter.report(result)')),
    /manual-check-notes-source/)
  assert.throws(() => showReleaseNotesInManualCheck(host.replace('detail: copy.installerUnavailable,', 'detail: copy.other,')),
    /manual-check-notes/)
})
