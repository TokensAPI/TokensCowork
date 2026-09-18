import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
test('market fetch explicitly disables submodule recursion', () => {
  const fetchLine = read('deploy.sh').split('\n').find(line => line.startsWith('git ') && line.includes(' fetch '))
  assert.match(fetchLine, /fetch --no-recurse-submodules /)
  assert.match(fetchLine, /refs\/heads\/master:refs\/remotes\/origin\/master/)
})
test('archived image source remains readable despite private deployment umask', () => {
  const script = read('deploy.sh')
  assert.ok(script.indexOf('chmod -R a+rX "$release/market/server"') > script.indexOf('archive "$sha"'))
  assert.ok(script.indexOf('chmod -R a+rX "$release/market/server"') < script.indexOf('docker build'))
})
for (const file of ['deploy.sh']) {
  test(`${file} has valid Bash syntax`, () => {
    const result = spawnSync(bash, ['-n'], { input: read(file), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })
}
for (const path of ['/', 'relative', '/tmp/a;id', '/tmp/a b']) {
  test('reject invalid path ' + path, () => {
    const result = spawnSync(bash, ['-s', '--', 'a'.repeat(40), path], {input:read('deploy.sh'), encoding:'utf8'})
    assert.equal(result.status, 64, result.stderr)
  })
}
test('deployment rejects invalid SHA before accessing server resources', () => {
  const result = spawnSync(bash, ['-s', '--', 'HEAD'], {input:read('deploy.sh'), encoding:'utf8'})
  assert.equal(result.status, 64, result.stderr)
})
test('deployment safety contracts: backup before replacement, isolated existing volume and rollback', () => {
  const script = read('deploy.sh')
  assert.ok(script.indexOf('PRAGMA integrity_check') < script.indexOf('trap rollback ERR'))
  assert.ok(script.indexOf('test -s') < script.indexOf('trap rollback ERR'))
  assert.match(script, /external: true/)
  assert.match(script, /127\.0\.0\.1:4880:8080/)
  assert.match(script, /--no-build --no-deps market/)
  assert.match(script, /\/api\/admin\/subjects/)
  assert.match(script, /rollback_image/)
  assert.doesNotMatch(script, /docker compose[^\n]*\bdown\b/)
})
test('workflow requires passing tests, repository path and verified SSH host', () => {
  const workflow = read('../../.github/workflows/market-server.yml')
  assert.match(workflow, /needs: test/)
  assert.match(workflow, /vars.MARKET_DEPLOY_PATH/)
  assert.match(workflow, /StrictHostKeyChecking=yes/)
  assert.match(workflow, /< market\/deploy\/deploy.sh/)
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no|ssh-keyscan/)
})

test('known deployment coordinates are defaults; credentials remain secrets', () => {
  const workflow = read('../../.github/workflows/market-server.yml')
  for (const value of ['5.223.77.54', '/home/wsy/TokensCowork', "'wsy'", "'22'"]) assert.ok(workflow.includes(value))
  assert.match(workflow, /secrets.MARKET_SSH_PRIVATE_KEY/)
  assert.match(workflow, /secrets.MARKET_SSH_KNOWN_HOSTS/)
})

for (const count of [1, 3, 7]) {
  test(`retention keeps current plus newest snapshots out of ${count}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'market-retention-'))
    try {
      mkdirSync(join(dir, 'backups'))
      const names = Array.from({length:count}, (_, i) => `market-202609${String(i+1).padStart(2,'0')}T120000Z-${'a'.repeat(40)}.sqlite`)
      for (const name of [...names, 'manual.sqlite', 'market-invalid.sqlite']) writeFileSync(join(dir, 'backups', name), 'fixture')
      mkdirSync(join(dir, 'backups', 'market-20260101T120000Z-' + 'b'.repeat(40) + '.sqlite'))
      const fn = read('deploy.sh').match(/prune_backups\(\) \{[\s\S]*?\n\}/)[0]
      const result = spawnSync(bash, ['-s'], {cwd:dir, input:`set -euo pipefail\n${fn}\nprune_backups ./backups '${names[0]}'\n`, encoding:'utf8'})
      assert.equal(result.status, 0, result.stderr)
      const remaining = readdirSync(join(dir, 'backups'))
      assert.ok(remaining.includes('manual.sqlite'))
      assert.ok(remaining.includes('market-invalid.sqlite'))
      assert.ok(remaining.includes(names[0]))
      assert.deepEqual(remaining.filter(n=>names.includes(n)).sort(), [...new Set([names[0], ...names.slice(1).reverse().slice(0,2)])].sort())
    } finally {
      rmSync(dir, {recursive:true, force:true})
    }
  })
}
