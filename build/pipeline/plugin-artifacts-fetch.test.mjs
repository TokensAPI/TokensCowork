import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadWithRetry } from './plugin-artifacts-fetch.mjs'

const response = (status, body = 'tgz') => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => new TextEncoder().encode(body).buffer })
const quiet = { delays: [0, 0, 0], log: () => {} }

test('transient 5xx and network errors are retried until the download succeeds', async () => {
  const replies = [response(504), Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), response(200, 'ok')]
  const lines = []
  const fetchImpl = async () => { const next = replies.shift(); if (next instanceof Error) throw next; return next }
  const buffer = await downloadWithRetry('https://example.test/a.tgz', 'ui', { ...quiet, fetchImpl, log: line => lines.push(line) })
  assert.equal(buffer.toString(), 'ok')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /HTTP 504; retrying/)
  assert.match(lines[1], /ECONNRESET; retrying/)
})

test('4xx fails at once; persistent 5xx gives up after four attempts', async () => {
  let calls = 0
  await assert.rejects(downloadWithRetry('u', 'ui', { ...quiet, fetchImpl: async () => { calls += 1; return response(404) } }), /HTTP 404/)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(downloadWithRetry('u', 'ui', { ...quiet, fetchImpl: async () => { calls += 1; return response(503) } }), /HTTP 503 after 4 attempts/)
  assert.equal(calls, 4)
})
