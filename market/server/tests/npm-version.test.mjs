import test from 'node:test'
import assert from 'node:assert/strict'
import { liveCatalog, resolveNpmVersions } from '../services/npm-version-service.js'

const item={id:'fixture',package:'@fixture/tool',version:'1.0.0',state:'published',npm:true,versionMode:'pinned',summary:'Keep this'}
test('legacy npm pinned records also follow stable latest without mutating metadata',async t=>{
 let latest='2.0.0'
 t.mock.method(globalThis,'fetch',async()=>Response.json({latest}))
 assert.equal((await liveCatalog([item]))[0].version,'2.0.0')
 latest='3.0.0'
 assert.equal((await liveCatalog([item]))[0].version,'3.0.0')
 assert.equal(item.version,'1.0.0');assert.equal(item.versionMode,'pinned')
 const admin=await resolveNpmVersions([item])
 assert.equal(admin[0].version,'1.0.0');assert.equal(admin[0].npmLatestVersion,'3.0.0');assert.equal(admin[0].summary,'Keep this')
})
test('prerelease, malformed latest and network failure never advertise stale install versions',async t=>{
 let result={latest:'2.0.0-beta.1'}
 t.mock.method(globalThis,'fetch',async()=>{if(result===null)throw Error('offline');return Response.json(result)})
 for(const value of [{latest:'2.0.0-beta.1'},{latest:'^2.0.0'},{},null]) {
  result=value;assert.deepEqual(await liveCatalog([item]),[])
  assert.equal((await resolveNpmVersions([item]))[0].npmLatestVersion,'')
 }
})
test('drafts and unpublished npm entries are not resolved; Git targets remain pinned',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw Error('must not fetch')})
 const others=['draft','archived','deleted'].map(state=>({...item,state}))
 assert.deepEqual(await resolveNpmVersions(others),others)
 const git={...item,npm:false}
 assert.deepEqual(await liveCatalog([git]),[git])
})
test('npm resolution deduplicates names and bounds concurrent registry requests',async t=>{
 let active=0,max=0,calls=0
 t.mock.method(globalThis,'fetch',async()=>{
  calls++;active++;max=Math.max(max,active)
  await new Promise(resolve=>setTimeout(resolve,1));active--
  return Response.json({latest:'2.0.0'})
 })
 const items=Array.from({length:15},(_,i)=>({...item,package:'fixture-'+i}))
 const result=await resolveNpmVersions([...items,...items])
 assert.equal(calls,15);assert.ok(max<=6);assert.equal(result.length,30)
})
