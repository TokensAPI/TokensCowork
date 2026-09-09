import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { buildCatalogPage, buildSourceManifest, buildProductComponents } from '../../scripts/generate-market-catalog.mjs'
const root=resolve(import.meta.dirname,'../..')
const read=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'))
const config=read('market/source.config.json'), product=read('product.json')
if(JSON.stringify(read('market/source.json'))!==JSON.stringify(buildSourceManifest(config.origin)))throw new Error('Run npm --prefix market run build to refresh source.json')
const db=new DatabaseSync(':memory:')
try {
  const dir=resolve(root,'market/database/migrations')
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(resolve(dir,file),'utf8'))
  const items=db.prepare("SELECT metadata FROM market_plugins p JOIN market_catalog c ON p.id=c.id WHERE c.state='published'").all().map(p=>JSON.parse(p.metadata))
  buildCatalogPage({publisher:{name:'TokensAPI',url:'https://github.com/TokensAPI'},items})
  const builtins=buildProductComponents(product).items
  if(items.some(p=>builtins.some(b=>b.id===p.id)))throw new Error('Built-ins must not be marketplace entries')
  console.log(`Market migration verified: ${items.length} initial optional plugins; ${builtins.length} components derived from product.json.`)
} finally {db.close()}
