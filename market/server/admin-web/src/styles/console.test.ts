// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The conversation's blocks are named by kind (.log-user, .log-model, .log-tool …). A rule meant for
// something else under one of those names squeezes every block of that kind: `.log-model` once
// sized the filter bar's model picker, and every answer was drawn 13rem wide (T0107).
const css = readFileSync(new URL('./console.css', import.meta.url), 'utf8')
describe('console.css', () => {
  it('styles the conversation blocks only as blocks', () => {
    for (const kind of ['log-user', 'log-model', 'log-tool', 'log-context', 'log-answer'])
      expect(css, kind).not.toMatch(new RegExp(`(^|[\\s,}])\\.${kind}\\s*\\{`, 'mu'))
  })
})
