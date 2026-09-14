import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

export function verifyAsarPresetDiscovery(source) {
  const match = /function packageInstalled\(name, base\) \{[\s\S]*?\n\}/u.exec(source)
  assert.ok(match, 'agent-presets discovery function missing')
  assert.ok(match[0].includes('dsh-plugin-desktop.asar-module-resolver'), 'Desktop asar resolver guard missing')
  for (const present of [true, false]) {
    let resolved = 0
    const context = {
      createRequire: () => ({ resolve: name => {
        assert.equal(name, '@test/plugin/client')
        resolved++
        if (!present) throw new Error('MODULE_NOT_FOUND')
        return '/app.asar/node_modules/@test/plugin/client.js'
      } }),
    }
    const result = runInNewContext(`globalThis[Symbol.for('dsh-plugin-desktop.asar-module-resolver')] = 1;
      ${match[0]}; packageInstalled('@test/plugin/client', 'file:///profile/')`, context)
    assert.equal(result, present)
    assert.equal(resolved, 1, 'discovery must resolve the full export without loading it')
  }
}
