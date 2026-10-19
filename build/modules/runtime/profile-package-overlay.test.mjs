import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { AnchorError } from '../../pipeline/anchors.mjs'
import { keepDshRuntimeSeries } from './profile-package-overlay.mjs'

// Exercise the actual pinned upstream selector before and after the overlay.
const root = resolve(import.meta.dirname, '../../..')
const upstream = readFileSync(resolve(root, 'desktop/dsh-plugin-desktop/src/package-overlay.ts'), 'utf8')

// SemVer precedence for the versions used below; staging runs upstream specs with the real package.
const semverShim = `
const parse = v => { const m = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$/.exec(v); return m && { n: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : [] } }
export const valid = v => parse(v) ? v : null
export const major = v => parse(v).n[0]
export const minor = v => parse(v).n[1]
export function compare(a, b) {
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1
    if (y.pre[i] === undefined) return 1
    if (x.pre[i] !== y.pre[i]) return (/^\\d+$/.test(x.pre[i]) && /^\\d+$/.test(y.pre[i]) ? Number(x.pre[i]) > Number(y.pre[i]) : x.pre[i] > y.pre[i]) ? 1 : -1
  }
  return 0
}`

function pkg(directory, name, version, extra = {}) {
  const target = join(directory, 'node_modules', ...name.split('/'))
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version, ...extra }))
}

async function load(t, source, label) {
  const directory = mkdtempSync(join(tmpdir(), `profile-overlay-${label}-`))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'node_modules', 'semver'), { recursive: true })
  writeFileSync(join(directory, 'node_modules', 'semver', 'package.json'), '{"name":"semver","type":"module","exports":"./index.js"}')
  writeFileSync(join(directory, 'node_modules', 'semver', 'index.js'), semverShim)
  writeFileSync(join(directory, 'package-overlay.mjs'), stripTypeScriptTypes(source))
  return import(pathToFileURL(join(directory, 'package-overlay.mjs')).href)
}

/** A Mac-like layout: Desktop install, plus ~/.dsh shared with another DSH program. */
function layout(t) {
  const base = mkdtempSync(join(tmpdir(), 'profile-layout-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const install = join(base, 'TokensCowork.app', 'app')
  const profile = join(base, 'home', '.dsh', 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  mkdirSync(install, { recursive: true })
  writeFileSync(join(install, 'package.json'), '{"name":"dsh-plugin-desktop"}')
  writeFileSync(join(profile, 'package.json'), '{"name":"profile"}')
  pkg(install, '@deepseek-ai/dsh-web-app', '0.2.0-rc.2', { dsh: { bundle: { patch: ['./cordis.patch.yml'] } } })
  return {
    install, profile, sharedModules: join(base, 'home', '.dsh', 'profiles'),
    options: {
      installPackageUrl: pathToFileURL(join(install, 'package.json')).href,
      profilePackageUrl: pathToFileURL(join(profile, 'package.json')).href,
    },
  }
}

const nextSeries = { dsh: { bundle: { patch: ['./cordis.patch.yml'], loader: 'next' } } }

test('upstream already ignores shared profiles/node_modules; the overlay keeps that behavior', async t => {
  const original = await load(t, upstream, 'original')
  const patched = await load(t, keepDshRuntimeSeries(upstream), 'patched')
  const home = layout(t)
  pkg(home.sharedModules, '@deepseek-ai/dsh-web-app', '0.3.0', nextSeries)
  for (const module of [original, patched]) {
    assert.equal(module.resolveOverlayPackage('@deepseek-ai/dsh-web-app', home.options).selected.source, 'install')
  }
})

test('a next-series DSH runtime package written into the shared Profile keeps the bundled runtime', async t => {
  const original = await load(t, upstream, 'series-original')
  const patched = await load(t, keepDshRuntimeSeries(upstream), 'series')
  const crossSeries = layout(t)
  pkg(crossSeries.profile, '@deepseek-ai/dsh-web-app', '0.3.0', nextSeries)
  // Upstream 2.0.17 would load the official program's newer series from the shared Profile.
  assert.equal(original.resolveOverlayPackage('@deepseek-ai/dsh-web-app', crossSeries.options).selected.version, '0.3.0')
  const selected = patched.resolveOverlayPackage('@deepseek-ai/dsh-web-app', crossSeries.options).selected
  assert.deepEqual([selected.source, selected.version], ['install', '0.2.0-rc.2'])

  const sameSeries = layout(t)
  pkg(sameSeries.profile, '@deepseek-ai/dsh-web-app', '0.2.1')
  assert.equal(patched.resolveOverlayPackage('@deepseek-ai/dsh-web-app', sameSeries.options).selected.source, 'profile')

  // Market plugin updates outside the DSH runtime family still override the installed copy.
  const plugin = layout(t)
  pkg(plugin.install, '@tokensapi/dsh-connect', '0.1.0')
  pkg(plugin.profile, '@tokensapi/dsh-connect', '0.2.0')
  assert.equal(patched.resolveOverlayPackage('@tokensapi/dsh-connect', plugin.options).selected.source, 'profile')
})

test('overlay rejects changed selector anchors', () => {
  assert.throws(() => keepDshRuntimeSeries(upstream.replace("import { compare, valid } from 'semver'", "import { compare, gt, valid } from 'semver'")), AnchorError)
  assert.throws(() => keepDshRuntimeSeries(keepDshRuntimeSeries(upstream)), AnchorError)
})
