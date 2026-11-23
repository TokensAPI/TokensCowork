// The console at /admin/ (admin-web/, built into admin/console/): its page is the build's
// index.html, only the build's own files are served beside it, its hashed files are cached for good,
// its page is revalidated, and every answer carries the console's security headers. The old preview
// address /admin/next/ sends people to /admin/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import worker, { CONSOLE_FILES } from '../market-worker.js'
import { createAssets } from '../runtime/adapters.mjs'

const serverRoot = resolve(import.meta.dirname, '..')
const ORIGIN = 'https://market.example'
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
const SECURITY = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy']
const security = response => SECURITY.map(name => response.headers.get(name))

/** A built console in a scratch copy of the served tree, with files the build would never write. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'market-admin-console-'))
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch {} })
  mkdirSync(join(root, 'admin/console/assets'), { recursive: true })
  mkdirSync(join(root, 'admin/console/sub'), { recursive: true })
  const files = {
    'admin/console/index.html': '<!doctype html><script type="module" src="/admin/console/assets/index-Ab_d-123.js"></script>' + '<div></div>'.repeat(40),
    'admin/console/theme.js': ';(() => {})()\n'.repeat(30),
    'admin/console/assets/index-Ab_d-123.js': 'export const app = 1\n'.repeat(40),
    'admin/console/assets/index-Zx9_-Qw0.css': 'body{color:red}\n'.repeat(40),
    // Not shaped like a build file, so never served even though it is on disk.
    'admin/console/assets/index.js': 'export {}\n',
    'admin/console/assets/index-Ab_d-123.js.map': '{}',
    'admin/console/assets/index-Ab_d-1234.js': 'export {}\n',
    'admin/console/notes.txt': 'internal',
    'admin/console/sub/index.html': '<!doctype html>',
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
  const env = { ASSETS: createAssets(root) }
  const get = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env)
  return { root, get }
}

test('/admin/ is the console\'s build; beside it only the build\'s own names are served', async t => {
  const { get } = scratch(t)
  for (const path of ['/admin/', '/admin/index.html']) {
    const page = await get(path)
    assert.equal(page.status, 200, path)
    assert.match(await page.text(), /\/admin\/console\/assets\/index-Ab_d-123\.js/u, path)
  }
  for (const path of ['/admin/console/theme.js', '/admin/console/assets/index-Ab_d-123.js', '/admin/console/assets/index-Zx9_-Qw0.css'])
    assert.equal((await get(path)).status, 200, path)
  for (const path of ['/admin/console/', '/admin/console/index.html', '/admin/console/assets/index.js', '/admin/console/assets/index-Ab_d-123.js.map',
    '/admin/console/assets/index-Ab_d-1234.js', '/admin/console/notes.txt', '/admin/console/sub/index.html', '/admin/console/assets/',
    '/admin/console/assets/%2e%2e/index-Ab_d-123.js', '/admin/console/assets/missing-Ab_d-123.js', '/admin/consolex/theme.js', '/admin'])
    assert.equal((await get(path)).status, 404, path)
  assert.equal((await get('/admin/', { method: 'POST' })).status, 405)
  // The rule itself, for names the build may give later chunks.
  assert.ok(CONSOLE_FILES.test('/admin/console/assets/KeysPage-B1c2D3e4.js'))
  assert.ok(!CONSOLE_FILES.test('/admin/console/assets/x-B1c2D3e4.html'))
})

test('the old preview address and its pages send people to /admin/', async t => {
  const { get } = scratch(t)
  for (const path of ['/admin/next', '/admin/next/', '/admin/next/index.html', '/admin/next/assets/index-Ab_d-123.js']) {
    const response = await get(path)
    assert.deepEqual([response.status, response.headers.get('location')], [308, `${ORIGIN}/admin/`], path)
  }
})

test('hashed files are kept for a year, the page and theme script are revalidated, all with the console\'s security headers', async t => {
  const { get } = scratch(t)
  for (const path of ['/admin/', '/admin/console/theme.js']) {
    const response = await get(path)
    assert.equal(response.headers.get('cache-control'), 'no-cache', path)
    assert.match(response.headers.get('etag'), /^W\/"[A-Za-z0-9_-]{27}"$/u, path)
    assert.deepEqual(security(response), [CSP, 'DENY', 'nosniff', 'no-referrer'], path)
  }
  const script = await get('/admin/console/assets/index-Ab_d-123.js')
  assert.deepEqual([script.headers.get('cache-control'), script.headers.get('content-type')], ['public, max-age=31536000, immutable', 'text/javascript; charset=utf-8'])
  assert.deepEqual(security(script), [CSP, 'DENY', 'nosniff', 'no-referrer'])
  const style = await get('/admin/console/assets/index-Zx9_-Qw0.css')
  assert.deepEqual([style.headers.get('cache-control'), style.headers.get('content-type')], ['public, max-age=31536000, immutable', 'text/css; charset=utf-8'])
  // Revalidation answers 304; compression is the console's (T0103).
  const page = await get('/admin/')
  const again = await get('/admin/', { headers: { 'if-none-match': page.headers.get('etag') } })
  assert.deepEqual([again.status, again.headers.get('cache-control')], [304, 'no-cache'])
  const br = await get('/admin/console/assets/index-Ab_d-123.js', { headers: { 'accept-encoding': 'gzip, br' } })
  assert.equal(br.headers.get('content-encoding'), 'br')
  assert.match(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString(), /export const app = 1/u)
  // The Pages _headers file says the same.
  assert.match(readFileSync(join(serverRoot, '_headers'), 'utf8'), /\/admin\/console\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/u)
})

// The real build, once `npm --prefix admin-web run build` has run (CI builds before testing).
const built = join(serverRoot, 'admin/console/index.html')
test('the built console loads nothing inline and only files the server serves', { skip: !existsSync(built) && 'admin/console/ is not built' }, async () => {
  const html = readFileSync(built, 'utf8')
  // script-src 'self' and style-src 'self': no inline script, no <style>, no style attribute.
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=/u)
  assert.doesNotMatch(html, /vite-ignore/u)
  const env = { ASSETS: createAssets(serverRoot) }
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map(match => match[1])
  assert.ok(references.some(path => /^\/admin\/console\/assets\/index-[A-Za-z0-9_-]{8}\.js$/u.test(path)), 'entry script')
  assert.equal((await worker.fetch(new Request(ORIGIN + '/admin/'), env)).status, 200)
  for (const path of references) {
    assert.ok(path.startsWith('/admin/'), `${path} is not a same-origin console file`)
    const response = await worker.fetch(new Request(ORIGIN + path), env)
    assert.equal(response.status, 200, path)
    if (path.endsWith('.js')) {
      const code = await response.text()
      // Vue's runtime-only build: templates are compiled ahead, nothing is evaluated from strings.
      assert.doesNotMatch(code, /\bnew Function\(|\beval\(/u, path)
      for (const [, chunk] of code.matchAll(/["'`](\.\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css))["'`]/gu))
        assert.equal((await worker.fetch(new Request(new URL(chunk, ORIGIN + path)), env)).status, 200, chunk)
    }
  }
})
