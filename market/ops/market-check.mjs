import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'..')
function files(directory){
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=resolve(directory,entry.name)
    return entry.isDirectory()?files(path):/\.(?:m?js)$/u.test(path)?[path]:[]
  })
}
for(const file of [resolve(root,'_worker.js'),...['server','admin/assets','ops','tests'].flatMap(path=>files(resolve(root,path)))]){
  const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'})
  if(result.status!==0)process.exit(1)
  for(const match of readFileSync(file,'utf8').matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/gu)){
    // Reading relative imports also catches broken paths introduced by file moves.
    readFileSync(resolve(dirname(file),match[1]))
  }
}
console.log('Market syntax and relative imports verified.')
