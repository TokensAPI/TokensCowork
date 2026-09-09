import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogEditor } from '../admin/assets/market-catalog-editor.js'

test('link import fills a draft form, preserves custom/existing IDs and never writes automatically', async t => {
  const elements = new Map()
  const get = id => {
    if (!elements.has(id)) elements.set(id, {value:'',textContent:'',open:false,addEventListener(){},reset(){},showModal(){this.open=true},close(){this.open=false}})
    return elements.get(id)
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis,'document')
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:get}})
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document})
  let reads=0,writes=0
  const p={package:'tokens-cowork-finance',suggestedId:'tokens-cowork-finance',version:'0.1.0-beta.1',displayName:'Finance',summary:'Fixture',readmeSummary:'Detailed finance introduction',readmeNotice:'Current README',repository:'',npm:true,prerelease:true,license:'UNLICENSED'}
  const editor=catalogEditor({request:async(path,data)=>{if(data)writes++;else reads++;return p},action:async fn=>fn(),reload:async()=>{},close:()=>{},isBusy:()=>false})
  editor.open()
  get('catalog-package').value='https://www.npmjs.com/package/tokens-cowork-finance'
  await get('catalog-import').onclick()
  assert.equal(get('catalog-package').value,p.package)
  assert.equal(get('catalog-id').value,p.suggestedId)
  assert.equal(get('catalog-version').value,p.version)
  assert.equal(get('catalog-summary').value,p.summary)
  assert.equal(get('catalog-readme-panel').hidden,false)
  get('catalog-use-readme').onclick()
  assert.equal(get('catalog-summary').value,p.readmeSummary)
  assert.equal(get('catalog-repository').required,false)
  assert.ok(get('catalog-error').textContent.includes('UNLICENSED'))
  assert.equal(editor.dirty(),true)
  get('catalog-id').value='my-custom-id'
  await get('catalog-import').onclick()
  assert.equal(get('catalog-id').value,'my-custom-id')
  editor.open({...p,id:'existing-id'})
  await get('catalog-import').onclick()
  assert.equal(get('catalog-id').value,'existing-id')
  get('catalog-kind').value='github';get('catalog-kind').onchange()
  assert.equal(get('catalog-repository').required,true)
  assert.equal(get('catalog-commit').required,true)
  assert.equal(reads,3);assert.equal(writes,0)
  editor.transition({...p,id:'existing-id',revision:2},'purge',false)
  assert.equal(get('purge-confirm-label').hidden,false)
  assert.equal(get('purge-confirm-id').required,true)
  assert.equal(get('lifecycle-submit').textContent,'彻底删除')
  get('purge-confirm-id').value='wrong'
  get('lifecycle-form').onsubmit({preventDefault(){}})
  assert.equal(writes,0)
  assert.ok(get('lifecycle-error').textContent.includes('完整插件 ID'))
  editor.transition({...p,id:'existing-id'},'restore',false)
  assert.equal(get('purge-confirm-label').hidden,true)
  assert.equal(get('purge-confirm-id').required,false)
})
