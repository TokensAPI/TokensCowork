const $ = id => document.getElementById(id)

async function json(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} → ${response.status}`)
  return response.json()
}

function cell(row, value, className = '') {
  const element = document.createElement('td')
  element.textContent = value
  element.className = className
  row.append(element)
  return element
}

async function load() {
  $('origin').textContent = location.origin
  $('refresh').disabled = true
  $('rows').replaceChildren()
  try {
    const [roster, live] = await Promise.all([json('/roster.json'), json('/v1/plugins')])
    const liveMap = new Map(live.items.map(item => [item.id, item]))
    const npmItems = roster.items.filter(item => item.npm)
    const versions = new Map(await Promise.all(npmItems.map(async item => {
      try { return [item.id, (await json('/api/latest?pkg=' + encodeURIComponent(item.package))).latest] }
      catch { return [item.id, null] }
    })))
    let drift = 0
    for (const item of roster.items) {
      const row = document.createElement('tr')
      const latest = item.npm ? versions.get(item.id) : item.version
      const current = liveMap.get(item.id)?.latestVersion ?? null
      const synced = latest !== null && latest !== undefined && current === latest
      if (!synced) drift++
      const title = cell(row, item.displayName)
      const packageName = document.createElement('div')
      packageName.className = 'pkg'; packageName.textContent = item.package; title.append(packageName)
      const summary = document.createElement('div')
      summary.className = 'sum hide-sm'; summary.textContent = item.summary; title.append(summary)
      cell(row, item.version, 'mono')
      cell(row, item.npm ? latest ?? '查询失败' : '不适用', 'mono')
      cell(row, current ?? '—', 'mono')
      cell(row, synced ? '已同步' : item.npm && latest === null ? 'npm 查询失败' : '待同步', 'hide-sm')
      $('rows').append(row)
    }
    $('stat-total').textContent = roster.items.length
    $('stat-npm').textContent = npmItems.length
    $('stat-live').textContent = live.items.length
    $('stat-drift').textContent = drift
  } catch (error) {
    const row = document.createElement('tr')
    const message = cell(row, `加载失败：${error.message}`)
    message.colSpan = 5; message.style.color = 'var(--bad)'; $('rows').append(row)
  } finally { $('refresh').disabled = false }
}

$('refresh').addEventListener('click', load)
void load()
