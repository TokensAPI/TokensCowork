import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { widenInstallCandidateRegistry } from './market-registry-overlay.mjs'

test('actual upstream candidate expression admits npm and self-hosted packages only', () => {
  const upstream = readFileSync(new URL('../../../desktop/dsh-community-market/src/install/service.ts', import.meta.url), 'utf8')
  const patched = widenInstallCandidateRegistry(upstream)
  // Extract the complete ternary rather than testing only a registry substring.
  const statement = patched.match(/const packageName = ([\s\S]*?\n\s*: undefined)/)
  assert.ok(statement)
  const candidate = new Function('item', 'source', 'safePackageName', `return (${statement[1]})`)
  for (const registry of ['npm', 'tokenscowork']) {
    assert.equal(candidate({package:{registry,name:'@fixture/tool'}},undefined,()=>true),'@fixture/tool')
    assert.equal(candidate({package:{registry,name:'invalid'}},undefined,()=>false),undefined)
    assert.equal(candidate({package:{registry,name:'@fixture/tool'}},{},()=>true),undefined)
  }
  assert.equal(candidate({package:{registry:'unknown',name:'@fixture/tool'}},undefined,()=>true),undefined)
  assert.equal(candidate({},undefined,()=>true),undefined)
  assert.throws(()=>widenInstallCandidateRegistry(patched),/anchor changed/)
})
