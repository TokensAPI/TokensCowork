import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionRoute, parseSessionRoute } from '../admin-web/src/lib/session-log-format.js'

// The session-log page's address (#session-logs/<session>/<format version>). How the console's page
// runs without locking itself is tested with the page (admin-web/src/pages/SessionLogsPage.test.ts).

test('a session has its own address, and anything malformed falls back to the list', () => {
  assert.equal(sessionRoute('session-1111-2222', 4), 'session-logs/session-1111-2222/4')
  assert.deepEqual(parseSessionRoute('#' + sessionRoute('session-a.b_c', 4)), { id: 'session-a.b_c', formatVersion: 4 })
  assert.deepEqual(parseSessionRoute('session-logs/session-x/12'), { id: 'session-x', formatVersion: 12 })
  for (const hash of ['', '#session-logs', '#session-logs/', '#session-logs/session-x', '#session-logs/session-x/v4', '#session-logs/session-x/4/more',
    '#session-logs/bad%20id/4', '#session-logs/%E0%A4%A/4', '#plugins/session-x/4', '#session-logs/' + 'a'.repeat(129) + '/4'])
    assert.equal(parseSessionRoute(hash), null, hash)
})
