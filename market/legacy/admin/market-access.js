const $ = id => document.getElementById(id)
let token = '', state, plugins = []
async function api(path, data) {
  const response = await fetch(path, { method: data ? 'PUT' : 'GET', cache: 'no-store', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '请求失败')
  return result
}
function option(select, value, label) { const el = document.createElement('option'); el.value = value; el.textContent = label; select.append(el) }
async function load() {
  state = await api('/api/admin/access')
  const response = await fetch('/roster.json', { cache: 'no-store' })
  if (!response.ok) throw new Error('无法加载公开目录')
  const roster = await response.json()
  const map = new Map(roster.items.map(p => [p.id, p]))
  for (const p of state.plugins) map.set(p.id, p.metadata)
  plugins = [...map.values()]
  $('key-select').replaceChildren(); option($('key-select'), '', '新增 Key')
  for (const k of state.keys) option($('key-select'), k.fingerprint, `${k.label} · ${k.enabled ? '启用' : '停用'} · ${k.fingerprint.slice(0, 8)}`)
  $('plugin-select').replaceChildren(); option($('plugin-select'), '', '新增插件')
  $('grants').replaceChildren()
  for (const p of plugins) {
    option($('plugin-select'), p.id, p.displayName)
    const label = document.createElement('label'), input = document.createElement('input')
    input.type = 'checkbox'; input.value = p.id
    label.append(input, document.createTextNode(` ${p.displayName}`)); $('grants').append(label)
  }
  $('editor').hidden = false
  $('key-select').dispatchEvent(new Event('change'))
  await renderOverview()
}
async function renderOverview() {
  $('origin').textContent = location.origin
  let items = plugins
  if (!state) {
    const response = await fetch('/roster.json', { cache: 'no-store' })
    if (!response.ok) throw new Error('无法加载目录')
    items = (await response.json()).items
  }
  const liveResponse = await fetch('/v1/plugins', { cache: 'no-store' })
  if (!liveResponse.ok) throw new Error('无法读取市场状态')
  const live = (await liveResponse.json()).items
  const versions = new Map(await Promise.all(items.filter(p => p.npm).map(async p => {
    try { const r = await fetch('/api/latest?pkg='+encodeURIComponent(p.package)); return [p.id, (await r.json()).latest] } catch { return [p.id, null] }
  })))
  $('rows').replaceChildren()
  let drift = 0
  for (const p of items) {
    const saved = state?.plugins.find(s => s.id === p.id)
    const restricted = saved?.visibility === 'restricted'
    const current = live.find(s => s.id === p.id)?.latestVersion
    const latest = p.npm ? versions.get(p.id) : p.version
    const matches = latest && current === latest
    if (!restricted && !matches) drift++
    const tr = document.createElement('tr')
    function cell(value, className = '') { const td = document.createElement('td'); td.textContent = value; td.className = className; tr.append(td); return td }
    const title = cell(p.displayName)
    const name = document.createElement('div'); name.className='pkg'; name.textContent=p.package; title.append(name)
    const summary = document.createElement('div'); summary.className='sum hide-sm'; summary.textContent=p.summary; title.append(summary)
    cell(p.version, 'mono'); cell(p.npm ? latest ?? '查询失败' : '不适用', 'mono'); cell(restricted ? '授权后可见' : current ?? '—', 'mono')
    cell(restricted ? '专属插件' : matches ? '已同步' : '待核对', 'hide-sm')
    const control = cell('')
    if (!state) { control.textContent = '登录后设置' }
    else {
      const keep = new Set(restricted ? state.grants.filter(g => g.plugin_id===p.id).map(g => g.fingerprint) : [])
      const list = document.createElement('div')
      for (const fp of keep) {
        const row = document.createElement('div'), remove = document.createElement('button')
        const key = state.keys.find(k => k.fingerprint===fp)
        row.append(document.createTextNode('已保存 Key · '+fp.slice(0,8)+(key && (!key.enabled || (key.expires_at && key.expires_at<=Date.now())) ? '（已停用/到期）' : '')+' '))
        remove.textContent='移除'; remove.onclick=() => { keep.delete(fp); row.remove() }
        row.append(remove); list.append(row)
      }
      const input = document.createElement('textarea'); input.rows=2; input.autocomplete='off'; input.spellcheck=false
      input.setAttribute('aria-label', p.displayName+' API Key'); input.placeholder='粘贴 API Key，每行一个'
      const note = document.createElement('div'); note.className='sub'; note.textContent='不配置 Key＝所有人可见；已保存的 Key 以指纹显示。'
      const save = document.createElement('button'); save.textContent='保存'
      save.onclick = () => action(async () => {
        await api('/api/admin/plugin-keys', { id:p.id, metadata:p, objectKey:saved?.object_key ?? null,
          apiKeys:input.value.split(/\r?\n/u).map(k=>k.trim()).filter(Boolean), keepFingerprints:[...keep] })
        input.value=''; await load()
      })
      control.append(list, input, note, save)
    }
    $('rows').append(tr)
  }
  $('stat-total').textContent = items.length; $('stat-npm').textContent = items.filter(p=>p.npm).length
  $('stat-live').textContent = live.length; $('stat-drift').textContent = drift
}
async function action(fn) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true)
  try { await fn(); $('message').textContent = '操作成功。' } catch (e) { $('message').textContent = e.message } finally { buttons.forEach(b => b.disabled = false) }
}
$('load').onclick = () => action(async () => { token = $('admin').value.trim(); $('admin').value = ''; await load() })
$('logout').onclick = () => { token = ''; location.reload() }
$('key-select').onchange = () => {
  const k = state.keys.find(k => k.fingerprint === $('key-select').value)
  $('api-key').value = ''; $('api-key').disabled = !!k
  $('label').value = k?.label ?? ''; $('enabled').checked = k ? !!k.enabled : true
  $('expires').value = k?.expires_at ? new Date(k.expires_at - new Date(k.expires_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
  const ids = state.grants.filter(g => g.fingerprint === k?.fingerprint).map(g => g.plugin_id)
  for (const input of $('grants').querySelectorAll('input')) input.checked = ids.includes(input.value)
}
$('key-form').onsubmit = event => { event.preventDefault(); action(async () => {
  const data = { label: $('label').value, enabled: $('enabled').checked, expiresAt: $('expires').value ? new Date($('expires').value).getTime() : null,
    plugins: [...$('grants').querySelectorAll('input:checked')].map(i => i.value) }
  if ($('key-select').value) data.fingerprint = $('key-select').value
  else data.apiKey = $('api-key').value.trim()
  $('api-key').value = ''
  await api('/api/admin/keys', data); await load()
}) }
$('plugin-select').onchange = () => {
  const id = $('plugin-select').value, p = plugins.find(p => p.id === id), saved = state.plugins.find(p => p.id === id)
  for (const [field, prop] of [['plugin-id','id'],['display-name','displayName'],['package-name','package'],['summary','summary'],['repository','repository'],['version','version']]) $(field).value = p?.[prop] ?? ''
  $('plugin-id').readOnly = !!p; $('npm').checked = p?.npm ?? false; $('visibility').value = saved?.visibility ?? 'public'; $('object-key').value = saved?.object_key ?? ''
}
$('plugin-form').onsubmit = event => { event.preventDefault(); action(async () => {
  const metadata = {}
  for (const [field, prop] of [['plugin-id','id'],['display-name','displayName'],['package-name','package'],['summary','summary'],['repository','repository'],['version','version']]) metadata[prop] = $(field).value.trim()
  metadata.npm = $('npm').checked
  await api('/api/admin/plugins', { id: metadata.id, metadata, visibility: $('visibility').value, objectKey: $('object-key').value || null }); await load()
}) }
$('refresh').onclick = () => action(() => token ? load() : renderOverview())
renderOverview().catch(e => { $('message').textContent=e.message })
