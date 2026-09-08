const $ = id => document.getElementById(id)
let state, plugins=[], selectedPlugin, busy=false, filter='all', retained=new Set()
let category='all'
let keyValues=new Map()
const isBuiltin=p=>p.category==='builtin'
const node=(tag,text,className='')=>{const el=document.createElement(tag);el.textContent=text;el.className=className;return el}
async function json(path,data) {
  const response=await fetch(path,{method:data?'PUT':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:data?{'content-type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{})})
  const value=await response.json()
  if(response.status===401){lock();throw new Error('管理凭证无效，请重新登录。')}
  if(!response.ok) throw new Error(value.error||'请求失败')
  return value
}
async function action(fn) {
  if(busy)return
  busy=true
  const controls=[...document.querySelectorAll('button,input,textarea')]
  controls.forEach(el=>el.disabled=true)
  try{await fn();$('message').textContent='数据已更新'}
  catch(error){$('message').textContent=error.message;$('plugin-error').textContent=error.message}
  finally{controls.forEach(el=>el.disabled=false);busy=false}
}
const savedPlugin=id=>state.plugins.find(p=>p.id===id)
const orgIds=id=>state.organizationGrants.filter(g=>g.plugin_id===id).map(g=>g.organization_id)
const migrated=id=>state.organizationPolicies.some(p=>p.plugin_id===id)
function keyGrants(id){
  if(migrated(id))return state.directKeyGrants.filter(g=>g.plugin_id===id).map(g=>g.fingerprint)
  return state.grants.filter(g=>g.plugin_id===id && state.keys.some(k=>k.fingerprint===g.fingerprint&&k.enabled&&(!k.expires_at||k.expires_at>Date.now()))).map(g=>g.fingerprint)
}
function organizationName(id){const org=state.organizations.find(o=>o.id===id);return org?org.name+' (#'+id+')'+(org.enabled?'':' · 已停用'):'#'+id}
function render(){
  $('plugin-grid').replaceChildren()
  const query=$('plugin-search').value.trim().toLowerCase()
  const visible=plugins.filter(p=>{const restricted=savedPlugin(p.id)?.visibility==='restricted';return (category==='all'||(category==='builtin')===isBuiltin(p))&&(filter==='all'||(filter==='restricted')===restricted)&&(p.displayName+' '+p.package).toLowerCase().includes(query)})
  for(const p of visible){
    const restricted=savedPlugin(p.id)?.visibility==='restricted',card=node('article','','plugin-card'),top=node('div','','card-top'),name=node('div','','card-name')
    name.append(node('h2',p.displayName),node('div',p.package,'package'))
    top.append(node('div',p.displayName.slice(0,1),'plugin-icon'),name,node('span',restricted?'受限':'公开','badge'+(restricted?' restricted':'')))
    const grants=node('div','','grant-summary'),ids=orgIds(p.id),keys=keyGrants(p.id)
    grants.append(node('span',isBuiltin(p)?'内置组件':'可选插件','chip'))
    if(isBuiltin(p))grants.append(node('span','无需安装 · 不支持卸载','chip'))
    else if(!restricted)grants.append(node('span','所有人可见','chip'))
    else{grants.append(node('span',ids.length+' 个组织','chip'),node('span',keys.length+' 个 Key','chip'));grants.title=ids.map(organizationName).join('、')}
    const bottom=node('div','','card-bottom'),edit=node('button','配置权限','secondary')
    edit.setAttribute('aria-label',p.displayName+' 配置权限');edit.onclick=()=>action(()=>openPlugin(p))
    bottom.append(node('span','v'+p.version+' · '+(isBuiltin(p)?'随应用更新':p.npm?'npm 自动同步':'名册版本'),'version'))
    if(isBuiltin(p))bottom.append(node('span','应用内置','muted'))
    else bottom.append(edit)
    card.append(top,node('p',p.summary,'description'),grants,bottom);$('plugin-grid').append(card)
  }
  $('empty').hidden=visible.length>0
  const restricted=plugins.filter(p=>savedPlugin(p.id)?.visibility==='restricted').length
  $('stat-total').textContent=plugins.length;$('stat-public').textContent=plugins.length-restricted;$('stat-restricted').textContent=restricted;$('stat-orgs').textContent=state.organizations.length
}
async function load(){
  const [next,roster]=await Promise.all([json('/api/admin/access'),json('/api/admin/roster')])
  const map=new Map(roster.items.map(p=>[p.id,p]))
  for(const p of next.plugins)map.set(p.id,{...p.metadata,category:map.get(p.id)?.category??'optional'})
  state=next;plugins=[...map.values()];render()
  $('sync-organizations').hidden=!state.organizationListReady
  $('provider-status').textContent=state.organizationProviderReady?'组织身份查询已接入。':'组织自动识别待接入；可以先配置组织，单独 API Key 授权现在即可使用。'
  $('organization-list').replaceChildren()
  for(const org of state.organizations){
    const row=node('div','','org-row'),edit=node('button','编辑','secondary')
    edit.onclick=()=>{if(busy)return;$('organization-id').value=org.id;$('organization-id').readOnly=true;$('organization-name').value=org.name;$('organization-enabled').checked=!!org.enabled;$('organization-name').focus()}
    row.append(node('span',organizationName(org.id)),edit);$('organization-list').append(row)
  }
  if(!state.organizations.length)$('organization-list').append(node('p','暂无组织，可在上方登记。','muted'))
}
const newKeys=()=>[...new Set($('api-keys').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))]
function updateScope(){
  const count=$('organization-options').querySelectorAll('input:checked').length,keyCount=retained.size+newKeys().length
  $('permission-summary').textContent=count||keyCount?count+' 个组织 · '+keyCount+' 个 Key':'所有人可见'
  $('public-confirmation').hidden=savedPlugin(selectedPlugin?.id)?.visibility!=='restricted'||!!count||!!keyCount
  if($('public-confirmation').hidden)$('confirm-public').checked=false
}
function renderKeys(){
  $('saved-keys').replaceChildren()
  for(const fp of retained){
    const row=node('div','','saved-key-row'),value=keyValues.get(fp),remove=node('button','移除','secondary')
    remove.type='button';remove.setAttribute('aria-label','移除 Key '+fp.slice(0,10))
    remove.onclick=()=>{if(busy)return;retained.delete(fp);renderKeys();updateScope()}
    row.append(node('code',value??'旧指纹 '+fp.slice(0,10)+'（重新录入后可显示完整 Key）'),remove);$('saved-keys').append(row)
  }
}
async function openPlugin(plugin){
  if(isBuiltin(plugin))return
  const values=await json('/api/admin/plugin-key-values?id='+encodeURIComponent(plugin.id))
  keyValues=new Map(values.keys.map(k=>[k.fingerprint,k.apiKey]))
  selectedPlugin=plugin;retained=new Set(keyGrants(plugin.id))
  $('plugin-title').textContent=plugin.displayName+' · 访问权限';$('plugin-error').textContent='';$('confirm-public').checked=false;$('api-keys').value='';$('organization-search').value=''
  const ids=new Set(orgIds(plugin.id));$('organization-options').replaceChildren()
  for(const org of state.organizations){const label=node('label',''),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=org.id;checkbox.checked=ids.has(org.id);checkbox.onchange=updateScope;label.append(checkbox,document.createTextNode(' '+organizationName(org.id)));$('organization-options').append(label)}
  if(!state.organizations.length)$('organization-options').textContent='暂无组织，请先在下方组织名录登记；也可直接配置 API Key。'
  $('legacy-note').hidden=migrated(plugin.id)||!retained.size
  renderKeys();updateScope();$('plugin-dialog').showModal()
}
$('refresh').onclick=()=>action(load)
$('plugin-search').oninput=()=>{if(state)render()}
$('category-filter').onchange=()=>{category=$('category-filter').value;if(state)render()}
for(const button of document.querySelectorAll('[data-filter]'))button.onclick=()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));if(state)render()}
$('cancel-plugin').onclick=()=>$('plugin-dialog').close()
$('plugin-dialog').addEventListener('close',()=>{keyValues.clear();$('saved-keys').replaceChildren();$('api-keys').value=''})
$('plugin-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault()})
$('organization-search').oninput=()=>{for(const label of $('organization-options').querySelectorAll('label'))label.hidden=!label.textContent.toLowerCase().includes($('organization-search').value.toLowerCase())}
$('api-keys').oninput=updateScope
$('plugin-access-form').onsubmit=event=>{
  event.preventDefault()
  if(!$('public-confirmation').hidden&&!$('confirm-public').checked){$('plugin-error').textContent='请确认将插件公开，或保留至少一项授权。';return}
  const plugin=selectedPlugin,payload={id:plugin.id,metadata:plugin,objectKey:savedPlugin(plugin.id)?.object_key??null,organizationIds:[...$('organization-options').querySelectorAll('input:checked')].map(i=>Number(i.value)),apiKeys:newKeys(),keepFingerprints:[...retained],confirmPublic:$('confirm-public').checked}
  action(async()=>{await json('/api/admin/plugin-access',payload);$('api-keys').value='';$('plugin-dialog').close();await load()})
}
$('new-organization').onclick=()=>{$('organization-form').reset();$('organization-id').readOnly=false}
$('organization-form').onsubmit=event=>{event.preventDefault();action(async()=>{await json('/api/admin/organizations',{id:Number($('organization-id').value),name:$('organization-name').value.trim(),enabled:$('organization-enabled').checked});$('organization-form').reset();$('organization-id').readOnly=false;await load()})}
$('sync-organizations').onclick=()=>action(async()=>{await json('/api/admin/organizations/sync',{});await load()})
function lock(){
  document.body.classList.add('signed-out')
  state=null;plugins=[];selectedPlugin=null;keyValues.clear();retained.clear()
  $('plugin-dialog').close();$('saved-keys').replaceChildren();$('api-keys').value='';$('admin-token').value=''
  $('plugin-grid').replaceChildren();$('organization-list').replaceChildren();$('organization-options').replaceChildren();$('organization-form').reset()
  $('workspace').hidden=true;$('session-actions').hidden=true;$('login-panel').hidden=false
}
$('logout').onclick=()=>action(async()=>{await json('/api/admin/logout',{});lock();$('admin-token').focus()})
$('login-form').onsubmit=event=>{
  event.preventDefault()
  const credential=$('admin-token').value.trim()
  action(async()=>{$('admin-token').value='';await json('/api/admin/login',{credential});await restore()})
}
async function restore(){
  try{await load();document.body.classList.remove('signed-out');$('workspace').hidden=false;$('session-actions').hidden=false;$('login-panel').hidden=true}
  catch(error){lock();throw error}
}
action(restore)
