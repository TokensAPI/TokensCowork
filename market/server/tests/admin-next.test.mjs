// The new console at /admin/next/ (admin-web/, built into admin/next/): only the build's own files
// are served, its hashed files are cached for good, its page is revalidated, and it carries exactly
// the security headers of the console at /admin/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import worker, { NEXT_CONSOLE } from '../market-worker.js'
import { createAssets } from '../runtime/adapters.mjs'

const serverRoot = resolve(import.meta.dirname, '..')
const ORIGIN = 'https://market.example'
const SECURITY = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy']
const security = response => SECURITY.map(name => response.headers.get(name))

/** A built console in a scratch copy of the served tree, with files the build would never write. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'market-admin-next-'))
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch {} })
  mkdirSync(join(root, 'admin/next/assets'), { recursive: true })
  mkdirSync(join(root, 'admin/next/sub'), { recursive: true })
  const files = {
    'admin/index.html': '<!doctype html><main>' + 'old console '.repeat(40) + '</main>',
    'admin/next/index.html': '<!doctype html><script type="module" src="/admin/next/assets/index-Ab_d-123.js"></script>' + '<div></div>'.repeat(40),
    'admin/next/theme.js': ';(() => {})()\n'.repeat(30),
    'admin/next/assets/index-Ab_d-123.js': 'export const app = 1\n'.repeat(40),
    'admin/next/assets/index-Zx9_-Qw0.css': 'body{color:red}\n'.repeat(40),
    // Not shaped like a build file, so never served even though it is on disk.
    'admin/next/assets/index.js': 'export {}\n',
    'admin/next/assets/index-Ab_d-123.js.map': '{}',
    'admin/next/assets/index-Ab_d-1234.js': 'export {}\n',
    'admin/next/notes.txt': 'internal',
    'admin/next/sub/index.html': '<!doctype html>',
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
  const env = { ASSETS: createAssets(root) }
  const get = (path, headers = {}) => worker.fetch(new Request(ORIGIN + path, { headers }), env)
  return { root, get }
}

test('only the build\'s own names under /admin/next/ are served', async t => {
  const { get } = scratch(t)
  for (const path of ['/admin/next/', '/admin/next/index.html', '/admin/next/theme.js', '/admin/next/assets/index-Ab_d-123.js', '/admin/next/assets/index-Zx9_-Qw0.css'])
    assert.equal((await get(path)).status, 200, path)
  for (const path of ['/admin/next/assets/index.js', '/admin/next/assets/index-Ab_d-123.js.map', '/admin/next/assets/index-Ab_d-1234.js',
    '/admin/next/notes.txt', '/admin/next/sub/index.html', '/admin/next/sub/', '/admin/next/assets/', '/admin/next/assets/%2e%2e/index-Ab_d-123.js',
    '/admin/next/assets/missing-Ab_d-123.js', '/admin/next/../next/notes.txt', '/admin/nextx/index.html'])
    assert.equal((await get(path)).status, 404, path)
  const bare = await get('/admin/next')
  assert.deepEqual([bare.status, bare.headers.get('location')], [308, `${ORIGIN}/admin/next/`])
  // The rule itself, for names the build may give later chunks.
  assert.ok(NEXT_CONSOLE.test('/admin/next/assets/KeysPage-B1c2D3e4.js'))
  assert.ok(!NEXT_CONSOLE.test('/admin/next/assets/x-B1c2D3e4.html'))
})

test('hashed files are kept for a year, the page and theme script are revalidated, all with /admin/\'s security headers', async t => {
  const { get } = scratch(t)
  const old = await get('/admin/')
  assert.equal(old.status, 200)
  for (const path of ['/admin/next/', '/admin/next/index.html', '/admin/next/theme.js']) {
    const response = await get(path)
    assert.equal(response.headers.get('cache-control'), 'no-cache', path)
    assert.match(response.headers.get('etag'), /^W\/"[A-Za-z0-9_-]{27}"$/u, path)
    assert.deepEqual(security(response), security(old), path)
  }
  const script = await get('/admin/next/assets/index-Ab_d-123.js')
  assert.deepEqual([script.headers.get('cache-control'), script.headers.get('content-type')], ['public, max-age=31536000, immutable', 'text/javascript; charset=utf-8'])
  assert.deepEqual(security(script), security(old))
  const style = await get('/admin/next/assets/index-Zx9_-Qw0.css')
  assert.deepEqual([style.headers.get('cache-control'), style.headers.get('content-type')], ['public, max-age=31536000, immutable', 'text/css; charset=utf-8'])
  // The CSP is the console's: same-origin scripts and styles only, nothing inline.
  assert.match(script.headers.get('content-security-policy'), /script-src 'self';.*style-src 'self';/u)
  assert.doesNotMatch(script.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/u)
  // Revalidation answers 304; compression is the console's (T0103).
  const page = await get('/admin/next/')
  const again = await get('/admin/next/', { 'if-none-match': page.headers.get('etag') })
  assert.deepEqual([again.status, again.headers.get('cache-control')], [304, 'no-cache'])
  const br = await get('/admin/next/assets/index-Ab_d-123.js', { 'accept-encoding': 'gzip, br' })
  assert.equal(br.headers.get('content-encoding'), 'br')
  assert.match(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString(), /export const app = 1/u)
  // The Pages _headers file says the same.
  assert.match(readFileSync(join(serverRoot, '_headers'), 'utf8'), /\/admin\/next\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/u)
})

// The real build, once `npm --prefix admin-web run build` has run (CI builds before testing).
const built = join(serverRoot, 'admin/next/index.html')
test('the built console loads nothing inline and only files the server serves', { skip: !existsSync(built) && 'admin/next/ is not built' }, async () => {
  const html = readFileSync(built, 'utf8')
  // script-src 'self' and style-src 'self': no inline script, no <style>, no style attribute.
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=/u)
  assert.doesNotMatch(html, /vite-ignore/u)
  const env = { ASSETS: createAssets(serverRoot) }
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map(match => match[1])
  assert.ok(references.some(path => /^\/admin\/next\/assets\/index-[A-Za-z0-9_-]{8}\.js$/u.test(path)), 'entry script')
  for (const path of references) {
    assert.ok(path.startsWith('/admin/'), `${path} is not same-origin console file`)
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
