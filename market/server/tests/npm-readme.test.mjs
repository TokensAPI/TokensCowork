import test from 'node:test'
import assert from 'node:assert/strict'
import { readmeSummary } from '../integrations/npm-readme.js'
import { npmPackage } from '../integrations/npm-registry.js'

const intro='基于银行流水生成基础资产负债表和利润表的 TokensCowork 本地插件。'
test('README introduction is offered separately from package description', async t => {
 t.mock.method(globalThis,'fetch',async url=>Response.json(url.endsWith('/latest')
  ? {name:'fixture-finance',version:'0.1.0-beta.1',description:'Short description'}
  : {name:'fixture-finance',readme:'# 财务插件\n\n'+intro+'\n\n> Beta only\n\n## 安装\nInstall instructions'}))
 const p=await npmPackage('fixture-finance')
 assert.equal(p.summary,'Short description');assert.equal(p.readmeSummary,intro)
 assert.ok(p.readmeNotice.includes('当前 README'))
})
test('README lookup failure does not break package import', async t => {
 t.mock.method(globalThis,'fetch',async url=>url.endsWith('/latest')
  ? Response.json({name:'fixture-finance',version:'1.0.0',description:'Still usable'})
  : new Response('Unavailable',{status:503}))
 const p=await npmPackage('fixture-finance')
 assert.equal(p.summary,'Still usable');assert.equal(p.readmeSummary,'');assert.ok(p.readmeNotice.includes('无法读取'))
})
test('README extraction skips headings, badges, code and HTML; produces bounded plain text', () => {
 assert.equal(readmeSummary('# Title\n\n[![build](https://image)](https://ci)\n\n'+intro),intro)
 assert.equal(readmeSummary('# Title\n\n```sh\nnpm install foo\n```\n\n'+intro),intro)
 assert.equal(readmeSummary('# Title\n\n~~~sh\nnpm install foo\n~~~\n\n'+intro),intro)
 assert.equal(readmeSummary('# Title\n\n<!-- hidden -->\n<script>alert(1)</script>\n\n**Useful** [tool](https://example.com).'),'Useful tool.')
 assert.equal(readmeSummary('# Title\n\n## Installation\nDo not use install instructions as intro'),'')
 assert.equal(readmeSummary(null),'')
 assert.equal(readmeSummary('x'.repeat(1100)).length,1000)
})
