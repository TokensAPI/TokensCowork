// Subject-oriented administration; no credentials in localStorage or list responses.
export function subjectManager({ json, action, reload }) {
  const el = (tag, text = '') => { const n = document.createElement(tag); n.textContent = text; return n }
  let state = { keys: [], organizations: [], plugins: [] }, keyPage = 0
  const pageSize = 10
  const pager = (page, total, change) => {
    const bar = el('div'); bar.className = 'subject-pager'
    const prev = el('button', '上一页'), next = el('button', '下一页')
    prev.type = next.type = 'button'; prev.className = next.className = 'secondary'
    prev.disabled = page === 0; next.disabled = (page + 1) * pageSize >= total
    prev.onclick = () => change(page - 1); next.onclick = () => change(page + 1)
    bar.append(el('span', `共 ${total} 项 · 第 ${page + 1} / ${Math.max(1, Math.ceil(total / pageSize))} 页`), prev, next)
    return bar
  }
  const panel = el('section'); panel.dataset.panel = 'keys'; panel.hidden = true
  const toolbar = el('div'); toolbar.className = 'toolbar'
  const search = el('input'); search.type = 'search'; search.placeholder = '搜索名称、标签、备注或指纹'; search.setAttribute('aria-label', '搜索 API Key')
  const create = el('button', '登记 API Key'); create.type = 'button'
  const list = el('div'); list.className = 'subject-table-wrap'
  toolbar.append(search, create); panel.append(toolbar, el('p', '名称和标签便于识别；标签不自动授予权限。公开插件无需授权。'), list)
  document.getElementById('workspace').append(panel)
  const dialog = el('dialog'); dialog.className = 'subject-dialog'; document.body.append(dialog)
  function render() {
    const q = search.value.trim().toLowerCase()
    list.replaceChildren()
    const matches = state.keys.filter(k => `${k.label} ${k.tags.join(' ')} ${k.notes} ${k.id}`.toLowerCase().includes(q))
    keyPage = Math.min(keyPage, Math.max(0, Math.ceil(matches.length / pageSize) - 1))
    const table = el('table'), head = el('thead'), header = el('tr'), body = el('tbody')
    for (const name of ['名称 / 指纹', '标签', '备注', '直接授权', '操作']) header.append(el('th', name))
    head.append(header); table.append(head, body); list.append(table)
    for (const key of matches.slice(keyPage * pageSize, (keyPage + 1) * pageSize)) {
      const row = el('tr'), name = el('td'), controls = el('td')
      name.append(el('strong', key.label), el('small', key.id.slice(0, 12)))
      row.append(name, el('td', key.tags.join(' · ') || '—'), el('td', key.notes || '—'), el('td', `${key.plugins.length} 个插件`))
      const edit = el('button', '管理插件与标签'); edit.type = 'button'; edit.onclick = () => open('key', key.id)
      controls.append(edit); row.append(controls); body.append(row)
    }
    if (!matches.length) list.append(el('p', '没有匹配的 API Key。'))
    list.append(pager(keyPage, matches.length, page => { keyPage = page; render() }))
  }
  function open(kind, id) {
    const subject = (kind === 'key' ? state.keys : state.organizations).find(s => s.id === String(id))
      || { kind, id: '', label: '', notes: '', tags: [], plugins: [], revision: 0 }
    const original = new Set(subject.plugins), selected = new Set(subject.plugins)
    let pluginPage = 0
    const form = el('form'), title = el('h2', kind === 'key' ? 'API Key 与插件授权' : `组织授权 · ${subject.name}`)
    const field = (label, value, multiline = false) => {
      const wrap = el('label', label), input = el(multiline ? 'textarea' : 'input'); input.value = value; wrap.append(input); form.append(wrap); return input
    }
    form.append(title)
    const label = field(kind === 'key' ? '名称' : '本地备注名（不修改组织名称）', subject.label); label.required = true; label.maxLength = 120
    const tags = field('标签（逗号分隔）', subject.tags.join(', ')); tags.maxLength = 800
    const notes = field('备注', subject.notes, true); notes.maxLength = 1000
    let apiKey
    if (kind === 'key' && !subject.id) { apiKey = field('API Key', ''); apiKey.type = 'password'; apiKey.autocomplete = 'off'; apiKey.required = true; apiKey.maxLength = 512 }
    form.append(el('p', '组织授权与 Key 直接授权取并集。取消这里的勾选不会撤销其他途径获得的权限，也不会把插件改为公开。'))
    if (kind === 'organization' && !subject.enabled) form.append(el('p', '该组织已停用；保存授权不会自动启用组织。'))
    const filter = field('筛选插件', ''); filter.type = 'search'
    const scope = el('select'); scope.setAttribute('aria-label', '插件授权筛选')
    for (const [value, text] of [['all','全部插件'],['restricted','受限插件'],['selected','已选授权'],['public','公开插件']]) { const option = el('option',text); option.value=value; scope.append(option) }
    const summary = el('p'); summary.className = 'subject-selection-summary'
    const options = el('div'); options.className = 'subject-options'; form.append(scope, summary, options)
    function renderOptions() {
      options.replaceChildren()
      const matches = state.plugins.filter(p => p.state !== 'deleted' && `${p.name} ${p.id}`.toLowerCase().includes(filter.value.toLowerCase()) && (scope.value === 'all' || scope.value === 'selected' ? scope.value !== 'selected' || selected.has(p.id) : p.visibility === scope.value))
      pluginPage = Math.min(pluginPage, Math.max(0, Math.ceil(matches.length / pageSize) - 1))
      summary.textContent = `已选 ${selected.size} 项直接授权 · 公开插件无需勾选`
      const table = el('table'), head = el('thead'), header = el('tr'), body = el('tbody')
      for (const text of ['授权', '插件', '发布状态', '访问范围']) header.append(el('th',text))
      head.append(header); table.append(head,body); options.append(table)
      for (const p of matches.slice(pluginPage * pageSize, (pluginPage + 1) * pageSize)) {
        const row = el('tr'), cell = el('td'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(p.id); checkbox.setAttribute('aria-label', `授权 ${p.name}`)
        checkbox.disabled = p.visibility === 'public' || (kind === 'organization' && !p.mixed)
        checkbox.onchange = () => { checkbox.checked ? selected.add(p.id) : selected.delete(p.id); renderOptions() }
        cell.append(checkbox)
        row.append(cell,el('td',p.name),el('td',({published:'已上架',archived:'已下架',draft:'草稿'})[p.state] || p.state),el('td',p.visibility === 'public' ? '公开 · 所有人可访问' : kind === 'organization' && !p.mixed ? '旧权限模式，请先在插件页保存' : '受限'))
        body.append(row)
      }
      options.append(pager(pluginPage,matches.length,page => { pluginPage=page; renderOptions() }))
    }
    filter.oninput = () => { pluginPage=0; renderOptions() }; scope.onchange = filter.oninput; renderOptions()
    const error = el('p'); error.setAttribute('role', 'alert'); form.append(error)
    const save = el('button', '保存'), cancel = el('button', '取消'); save.type = 'submit'; cancel.type = 'button'; cancel.className = 'secondary'
    const draft = () => JSON.stringify([label.value, tags.value, notes.value, apiKey?.value, [...selected].sort()])
    const baseline = draft()
    const close = () => { if (draft() === baseline || confirm('放弃未保存的修改？')) { dialog.close(); dialog.replaceChildren() } }
    cancel.onclick = close; dialog.oncancel = event => { event.preventDefault(); close() }
    const footer = el('div'); footer.className = 'subject-dialog-footer'; footer.append(cancel,save); form.append(footer)
    form.onsubmit = event => {
      event.preventDefault()
      const added = [...selected].filter(id => !original.has(id)).length, removed = [...original].filter(id => !selected.has(id)).length
      if ((added || removed) && !confirm(`将新增 ${added} 项、撤销 ${removed} 项直接授权。其他授权途径保持不变，确认保存？`)) return
      const payload = { kind, id: subject.id, label: label.value.trim(), notes: notes.value.trim(), tags: tags.value.split(/[,，]/u).map(t => t.trim()).filter(Boolean),
        revision: subject.revision, plugins: [...selected], pluginRevisions: Object.fromEntries(state.plugins.map(p => [p.id, p.revision])), ...(apiKey ? { apiKey: apiKey.value.trim() } : {}) }
      action(async () => {
        try { await json('/api/admin/subjects', payload) }
        catch (e) { error.textContent = e.message; throw e }
        dialog.close(); dialog.replaceChildren(); await reload()
      }, { success: '授权名录已保存。' })
    }
    dialog.replaceChildren(form); dialog.showModal()
  }
  search.oninput = () => { keyPage=0; render() }; create.onclick = () => open('key')
  return { set(value) { state = value; render() }, open, keys: () => state.keys, organizations: () => state.organizations,
    clear() { state = { keys: [], organizations: [], plugins: [] }; search.value = ''; list.replaceChildren(); dialog.close(); dialog.replaceChildren() } }
}
