import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { importPackages } from './import-cached-packages.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-import-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, '@fixture/pkg')
  fs.mkdirSync(dir, { recursive: true })
  const bytes = Buffer.from('fixture archive bytes')
  fs.writeFileSync(path.join(dir, 'pkg-1.0.0.tgz'), bytes)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name:'@fixture/pkg', versions:{'1.0.0':{dist:{tarball:'https://registry.npmjs.org/@fixture/pkg/-/pkg-1.0.0.tgz', shasum:crypto.createHash('sha1').update(bytes).digest('hex')}}}, 'dist-tags':{latest:'1.0.0'}, _uplinks:{npmjs:{}}, _distfiles:{}}))
  fs.writeFileSync(path.join(root,'.verdaccio-db.json'), JSON.stringify({list:['@fixture/existing'],secret:'fixture-secret'}))
  return root
}
test('dry run is read-only; import indexes package and preserves secret, tags, tarballs and backups', t => {
  const root=fixture(t), file=path.join(root,'@fixture/pkg/package.json')
  const before=fs.readFileSync(file,'utf8')
  assert.equal(importPackages(root,'https://registry.example',['@fixture/pkg']).applied,false)
  assert.equal(fs.readFileSync(file,'utf8'),before)
  const result=importPackages(root,'https://registry.example',['@fixture/pkg'],true)
  assert.equal(result.versions,1)
  assert.equal(fs.readFileSync(path.join(result.backup,'0.json'),'utf8'),before)
  const data=JSON.parse(fs.readFileSync(file))
  assert.equal(data._attachments['pkg-1.0.0.tgz'].version,'1.0.0')
  assert.deepEqual(data._uplinks,{})
  assert.equal(data.versions['1.0.0'].dist.tarball,'https://registry.example/@fixture/pkg/-/pkg-1.0.0.tgz')
  importPackages(root,'https://registry.example',['@fixture/pkg'],true)
  const db=JSON.parse(fs.readFileSync(path.join(root,'.verdaccio-db.json')))
  assert.deepEqual(db.list,['@fixture/existing','@fixture/pkg'])
  assert.equal(db.secret,'fixture-secret')
})
test('bad archive aborts before modifying metadata', t => {
  const root=fixture(t), file=path.join(root,'@fixture/pkg/package.json')
  const before=fs.readFileSync(file,'utf8')
  fs.writeFileSync(path.join(root,'@fixture/pkg/pkg-1.0.0.tgz'),'corrupted')
  assert.throws(()=>importPackages(root,'https://registry.example',['@fixture/pkg'],true),/Checksum mismatch/)
  assert.equal(fs.readFileSync(file,'utf8'),before)
})
test('reject traversal names',t=>{
  const root=fixture(t)
  assert.throws(()=>importPackages(root,'https://registry.example',['../secret'],true),/explicit scoped/)
})
