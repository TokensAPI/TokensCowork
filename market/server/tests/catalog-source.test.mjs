import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectCatalogSources, canServeRegistryPackage } from '../services/catalog-source-service.js'
const env={MARKET_PRIVATE_REGISTRY_ENABLED:'true', MARKET_PRIVATE_REGISTRY_URL:'https://registry.example/', MARKET_PRIVATE_REGISTRY_TOKEN:'fixture'}
test('source negotiation is optional, immutable and does not expose private-only entries to legacy clients',()=>{
 const items=[{id:'compatible',npm:true},{id:'private',npm:true,registry:'tokenscowork'},{id:'git',npm:false}]
 assert.deepEqual(selectCatalogSources(items,{},true),items)
 assert.deepEqual(selectCatalogSources(items,env,false),[items[0],items[2]])
 assert.equal(selectCatalogSources(items,env,true)[0].registry,'tokenscowork')
 assert.equal(items[0].registry,undefined)
 assert.equal(canServeRegistryPackage({npm:false}),false)
 assert.equal(canServeRegistryPackage({npm:true,registry:'unknown'}),false)
})
