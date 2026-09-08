const $ = id => document.getElementById(id)
let token = '', state = null, selectedPlugin = null, busy = false
let plugins = []

async function json(path, data, authenticated = false) {
  const response = await fetch(path, { method:data ? 'PUT':'GET', cache:'no-store', redirect:'error',
    headers:{...(authenticated ? {Authorization:'Bearer '+token}:{}),...(data ? {'content-type':'application/json'}:{})},
    ...(data ? {body:JSON.stringify(data)}:{}) })
  const value=await response.json()
  if(!response.ok) throw new Error(value.error || '请求失败，请重试')
  return value
}
async function action(fn) {
  if(busy) return
  busy=true
  const controls=[...document.querySelectorAll('button,input')]
  controls.forEach(el=>el.disabled=true)
  try { await fn(); $('message').textContent='已更新。' }
  catch(error) { $('message').textContent=error.message; $('plugin-error').textContent=error.message }
  finally { controls.forEach(el=>el.disabled=false); busy=false }
}
function cell(row, text, className='') {
  const td=document.createElement('td'); td.textContent=text; td.className=className; row.append(td); return td
}
function organizationName(id) {
  const org=state.organizations.find(o=>o.id===id)
  return org ? `${org.name} (#${id})${org.enabled?'':' · 已停用'}` : `#${id}`
}
async function load() {
  const next=token ? await json('/api/admin/access',null,true):null
  const [roster,live]=await Promise.all([json('/roster.json'),json('/v1/plugins')])
  const map=new Map(roster.items.map(p=>[p.id,p]))
  for(const p of next?.plugins ?? []) map.set(p.id,p.metadata)
  const items=[...map.values()]
  const versions=new Map(await Promise.all(items.filter(p=>p.npm).map(async p=>{
    try {return [p.id,(await json('/api/latest?pkg='+encodeURIComponent(p.package))).latest]} catch {return [p.id,null]}
  })))
  state=next; plugins=items
  $('rows').replaceChildren()
  let drift=0
  for(const p of plugins) {
    const saved=state?.plugins.find(s=>s.id===p.id)
    const restricted=saved?.visibility==='restricted'
    const policy=state?.organizationPolicies.some(s=>s.plugin_id===p.id)
    const current=live.items.find(s=>s.id===p.id)?.latestVersion
    const latest=p.npm ? versions.get(p.id):p.version
    const matches=latest && latest===current
    if(!restricted && !matches) drift++
    const row=document.createElement('tr'), title=cell(row,p.displayName)
    const packageName=document.createElement('div');packageName.className='pkg';packageName.textContent=p.package;title.append(packageName)
    cell(row,p.version,'mono');cell(row,p.npm ? latest??'查询失败':'不适用','mono')
    cell(row,restricted?'授权后可见':current??'—','mono')
    cell(row,restricted?'受限插件':matches?'已同步':'待核对','hide-sm')
    const ids=state?.organizationGrants.filter(g=>g.plugin_id===p.id).map(g=>g.organization_id)??[]
    const scope=cell(row,!state?'登录后配置':!restricted?'所有人':policy?ids.map(organizationName).join('、')||'暂未授权组织':'旧 Key 权限 · 待配置组织')
    if(state) {
      const edit=document.createElement('button');edit.textContent='配置组织';edit.setAttribute('aria-label',p.displayName+' 配置组织')
      edit.onclick=()=>openPlugin(p);scope.append(document.createElement('br'),edit)
    }
    $('rows').append(row)
  }
  $('origin').textContent=location.origin
  $('stat-total').textContent=plugins.length;$('stat-npm').textContent=plugins.filter(p=>p.npm).length
  $('stat-live').textContent=live.items.length;$('stat-drift').textContent=drift
  $('logout').hidden=!state;$('organizations-panel').hidden=!state;$('provider-status').hidden=!state
  if(state) {
    $('sync-organizations').hidden=!state.organizationListReady
    $('provider-status').textContent=state.organizationProviderReady?'组织身份查询已接入。':'组织身份查询待接入：现在可以配置组织和插件权限，自动识别客户组织尚未启用。'
    $('organization-list').replaceChildren()
    for(const org of state.organizations) {
      const row=document.createElement('p');row.textContent=organizationName(org.id)+' '
      const edit=document.createElement('button');edit.textContent='编辑';edit.onclick=()=>{
        $('organization-id').value=org.id;$('organization-id').readOnly=true
        $('organization-name').value=org.name;$('organization-enabled').checked=!!org.enabled
      };row.append(edit);$('organization-list').append(row)
    }
  }
}
function updatePublicConfirmation() {
  const restricted=state.plugins.find(p=>p.id===selectedPlugin?.id)?.visibility==='restricted'
  $('public-confirmation').hidden=!restricted || !!$('organization-options').querySelector('input:checked')
}
function openPlugin(plugin) {
  selectedPlugin=plugin;$('plugin-title').textContent=plugin.displayName+' · 可见组织'
  $('plugin-error').textContent='';$('confirm-public').checked=false;$('organization-search').value=''
  const ids=new Set(state.organizationGrants.filter(g=>g.plugin_id===plugin.id).map(g=>g.organization_id))
  $('organization-options').replaceChildren()
  for(const org of state.organizations) {
    const label=document.createElement('label'), checkbox=document.createElement('input')
    checkbox.type='checkbox';checkbox.value=org.id;checkbox.checked=ids.has(org.id)
    checkbox.onchange=updatePublicConfirmation
    label.append(checkbox,document.createTextNode(' '+organizationName(org.id)));$('organization-options').append(label)
  }
  if(!state.organizations.length) $('organization-options').textContent='还没有组织，请先在本页的「组织名录」登记组织。'
  $('legacy-note').hidden=!(state.plugins.find(p=>p.id===plugin.id)?.visibility==='restricted' && !state.organizationPolicies.some(p=>p.plugin_id===plugin.id))
  updatePublicConfirmation();$('plugin-dialog').showModal()
}
$('connect').onclick=()=>action(async()=>{
  const value=$('admin-token').value.trim()
  if(!value) throw new Error('请填写管理凭证')
  token=value;$('admin-token').value='';await load()
})
$('sync-organizations').onclick=()=>action(async()=>{await json('/api/admin/organizations/sync',{},true);await load()})
$('logout').onclick=()=>{token='';location.reload()}
$('refresh').onclick=()=>action(load)
$('cancel-plugin').onclick=()=> $('plugin-dialog').close()
$('organization-search').oninput=()=>{
  const query=$('organization-search').value.toLowerCase()
  for(const label of $('organization-options').querySelectorAll('label')) label.hidden=!label.textContent.toLowerCase().includes(query)
}
$('plugin-organizations-form').onsubmit=event=>{
  event.preventDefault()
  const organizationIds=[...$('organization-options').querySelectorAll('input:checked')].map(i=>Number(i.value))
  const saved=state.plugins.find(p=>p.id===selectedPlugin.id)
  if(saved?.visibility==='restricted' && !organizationIds.length && !$('confirm-public').checked) {
    $('plugin-error').textContent='请勾选确认，或选择允许访问的组织。';return
  }
  action(async()=>{
    await json('/api/admin/plugin-organizations',{id:selectedPlugin.id,metadata:selectedPlugin,objectKey:saved?.object_key??null,organizationIds,confirmPublic:$('confirm-public').checked},true)
    $('plugin-dialog').close();await load()
  })
}
$('new-organization').onclick=()=>{$('organization-form').reset();$('organization-id').readOnly=false}
$('organization-form').onsubmit=event=>{
  event.preventDefault();action(async()=>{
    await json('/api/admin/organizations',{id:Number($('organization-id').value),name:$('organization-name').value.trim(),enabled:$('organization-enabled').checked},true)
    $('organization-form').reset();$('organization-id').readOnly=false;await load()
  })
}
action(load)
