import { groupConversation, contextLabel, turnEnding, rawDocument, argumentSummary, splitTurn, processSummary, durationText } from './market-session-log-replay.js'
import { renderMarkdown } from './market-markdown.js'

/**
 * One session's detail page: an overview, then two tabs — 「对话」 (each turn shows what the user
 * typed and the model's final answer; model steps, tool call/result pairs and notes in between fold
 * into one block per turn; grouping lives in market-session-log-replay.js) and 「原始 JSON」 (the
 * whole session in the upload format, rendered in pieces, with downloads and copy). Every byte here
 * is user content, so it is only ever placed with textContent — final answers go through
 * market-markdown.js, which builds elements and text nodes only; long content is built only when
 * unfolded, so a large session stays responsive.
 */
export function sessionLogDetailView({ $, node, button, json, action, formatTime }, { keyLines, clientText, onBack }) {
  const PAGE = 1000
  const RAW_CHUNK = 256 * 1024
  const DIALOG_LIMIT = 2 * 1024 * 1024
  const time = (value) => (value ? formatTime(value) : '—')
  const number = (value) => Number(value || 0).toLocaleString('zh-CN')
  const size = (length) => (length >= 1024 * 1024 ? `${(length / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(length / 1024))} KB`)
  const pretty = (value) => {
    if (typeof value !== 'string') return JSON.stringify(value, null, 2) ?? ''
    try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
  }
  // Which turns' process folds are open ('opening' for before the first turn); kept across
  // re-renders (the internal-events switch) and cleared when another session opens.
  const openTurns = new Set()
  let current = null, header = null, events = [], showInternal = false, tab = 'conversation'
  let raw = null, rawShown = 0, observer = null

  // ── Building blocks ────────────────────────────────────────────────────────
  // Text that may be long: the first `lines` lines (or nothing) and a toggle that builds the full
  // text only when asked for.
  function foldText(text, { lines = 3, code = false, label = '展开', className = '' } = {}) {
    const box = node('div', '', 'log-fold' + (className ? ' ' + className : ''))
    const all = text.split('\n')
    const short = all.length <= Math.max(lines, 1) && text.length <= 600
    const textClass = 'log-text' + (code ? ' log-code' : '')
    if (lines && short) { box.append(node('pre', text, textClass)); return box }
    const preview = lines ? node('pre', all.slice(0, lines).join('\n').slice(0, 400) + '…', textClass + ' log-preview') : null
    const toggle = button(`${label}（${all.length} 行 · ${number(text.length)} 字符）`, () => {
      const open = box.classList.toggle('open')
      if (open && !box.querySelector('.log-full')) box.insertBefore(node('pre', text, textClass + ' log-full'), toggle)
      box.querySelector('.log-full').hidden = !open
      if (preview) preview.hidden = open
      toggle.textContent = open ? '收起' : `${label}（${all.length} 行 · ${number(text.length)} 字符）`
    }, 'quiet log-toggle')
    box.append(...[preview, toggle].filter(Boolean))
    return box
  }
  const jsonButton = (item) => button('JSON', () => showJson(item.events.length === 1 ? item.events[0] : item.events), 'quiet log-json')
  function blockHead(label, kind, item, ...extra) {
    const head = node('div', '', 'log-block-head')
    head.append(node('span', label, 'log-role ' + kind), ...extra.filter(Boolean).map((text) => (typeof text === 'string' ? node('span', text, 'muted') : text)))
    head.append(node('time', time(item.events[0]?.time), 'muted log-time'), jsonButton(item))
    return head
  }
  function block(kind, label, item, ...extra) {
    const box = node('div', '', 'log-block log-' + kind)
    box.append(blockHead(label, kind, item, ...extra))
    return box
  }

  // ── Conversation ───────────────────────────────────────────────────────────
  function renderItem(item, answer = null) {
    switch (item.kind) {
      case 'user': {
        const box = block('user', current.parentSession ? '委派任务' : '用户', item)
        box.append(item.text.length > 4000 ? foldText(item.text, { lines: 20 }) : node('pre', item.text, 'log-text'))
        return box
      }
      case 'context': {
        const labels = [...new Set(item.kinds.map(contextLabel))]
        const box = block('context', '上下文', item, `${labels.join('、')} · ${item.events.length} 条 · 系统注入`)
        const list = node('div', '', 'log-context-list')
        const toggle = button('展开', () => {
          if (!list.childElementCount) {
            item.events.forEach((event, index) => {
              list.append(node('div', contextLabel(item.kinds[index]), 'muted'), foldText(
                [event.data?.content].flat().map((part) => part?.text ?? '').join('\n') || pretty(event.data), { lines: 4, code: true }))
            })
          }
          list.hidden = !list.hidden
          toggle.textContent = list.hidden ? '展开' : '收起'
        }, 'quiet log-toggle')
        list.hidden = true
        box.append(toggle, list)
        return box
      }
      case 'model': {
        const box = block('model', '模型', item, item.model, item.step !== null ? `第 ${item.step} 步` : '')
        if (item.reasoning) box.append(foldText(item.reasoning, { lines: 2, label: '思考', className: 'log-reasoning' }))
        // The final answer's text is shown below the fold; its step keeps reasoning and usage here.
        if (item === answer) box.append(node('p', '（这一步的回答就是下方的最终回答）', 'muted'))
        else if (item.text) box.append(item.text.length > 6000 ? foldText(item.text, { lines: 30 }) : node('pre', item.text, 'log-text'))
        if (!item.reasoning && !item.text) box.append(node('p', '（这一步只调用了工具）', 'muted'))
        const usage = item.usage
        const facts = [
          usage.input ? `输入 ${number(usage.input)}` : '', usage.output ? `输出 ${number(usage.output)}` : '',
          usage.cacheRead ? `缓存读 ${number(usage.cacheRead)}` : '', usage.cacheWrite ? `缓存写 ${number(usage.cacheWrite)}` : '',
          usage.total ? `共 ${number(usage.total)} token` : '', item.interrupted ? '已中断' : '',
        ].filter(Boolean)
        if (facts.length) box.append(node('p', facts.join(' · '), 'muted log-usage'))
        return box
      }
      case 'tool': {
        const failed = item.result?.error
        const box = block('tool', '工具', item, node('strong', item.name), failed ? node('span', '出错', 'chip disabled') : null)
        if (item.arguments !== null) {
          box.append(node('div', argumentSummary(item.arguments) || '（无参数）', 'log-args log-code'))
          if (item.arguments !== '' && item.arguments !== '{}') box.append(foldText(pretty(item.arguments), { lines: 0, code: true, label: '完整参数' }))
        }
        if (!item.result) box.append(node('p', '没有收到结果', 'muted'))
        else box.append(node('div', '结果', 'muted log-result-label'), foldText(item.result.text || pretty(item.result.meta ?? {}), { lines: 3, code: true, label: '展开结果' }))
        return box
      }
      case 'note': {
        const line = node('div', '', 'log-note' + (item.tone ? ' ' + item.tone : ''))
        line.append(node('span', item.text, 'log-note-text'), node('time', time(item.events[0]?.time), 'muted log-time'))
        if (item.childId) line.append(button('打开子会话', () => action(() => openBySession(item.childId, '子会话的日志不在这里（可能未上传或已删除）。')), 'quiet log-toggle'))
        line.append(jsonButton(item))
        if (!item.detail) return line
        const box = node('div', '', 'log-note-box')
        box.append(line, foldText(item.detail, { lines: 0, label: '展开' }))
        return box
      }
      case 'internal':
      case 'other': {
        const [event] = item.events
        const internal = item.kind === 'internal'
        const line = node('div', '', 'log-note ' + (internal ? 'log-internal' : 'log-other'))
        line.append(node('span', item.missing ? `原文缺失 · ${event.type} #${event.seq}` : `${internal ? '内部' : '其他'} · ${event.type} #${event.seq}`, 'log-note-text'),
          node('time', time(event.time), 'muted log-time'), jsonButton(item))
        if (item.missing || internal) return line
        const box = node('div', '', 'log-note-box')
        box.append(line, foldText(pretty(event.data ?? {}), { lines: 0, code: true, label: '展开' }))
        return box
      }
    }
    return node('div')
  }
  // A turn reads as: what the person typed → one fold holding everything in between (closed by
  // default, built only when opened) → the final answer as Markdown, or a grey line saying why
  // there is none. The internal-events switch only changes what is inside the fold.
  function renderGroup(group) {
    const { users, answer, process, partial } = splitTurn(group)
    const visible = process.filter((item) => showInternal || item.kind !== 'internal')
    if (group.turn === null && !users.length && !visible.length) return null
    const key = group.turn ?? 'opening'
    const section = node('section', '', 'log-turn')
    const head = node('div', '', 'log-turn-head')
    if (group.turn === null) head.append(node('h3', '会话开始'))
    else {
      head.append(node('h3', `第 ${group.turn} 轮`), node('span', time(group.startedAt), 'muted'))
      if (group.endedAt && group.startedAt) head.append(node('span', `用时 ${durationText(group.endedAt - group.startedAt)}`, 'muted'))
      const ending = turnEnding(group.reason)
      head.append(node('span', ending, 'chip' + (group.reason?.kind === 'completed' ? '' : ' disabled')))
    }
    section.append(head, ...users.map((item) => renderItem(item)))
    if (process.length) {
      const fold = document.createElement('details')
      fold.className = 'log-process'
      fold.dataset.turn = String(key)
      const summary = document.createElement('summary')
      summary.textContent = processSummary(group, process)
      const body = node('div', '', 'log-process-body')
      fold.append(summary, body)
      const build = () => {
        if (body.childElementCount) return
        body.append(...(visible.length ? visible.map((item) => renderItem(item, answer))
          : [node('p', '这里只有内部事件，打开「显示内部事件」可以查看。', 'muted')]))
      }
      fold.addEventListener('toggle', () => {
        if (fold.open) { openTurns.add(key); build() } else openTurns.delete(key)
      })
      if (openTurns.has(key)) { build(); fold.open = true }
      section.append(fold)
    }
    if (answer) {
      const box = block('model log-answer', '回答', answer, answer.model)
      const body = node('div', '', 'log-md')
      body.append(renderMarkdown(answer.text))
      box.append(body)
      section.append(box)
    } else if (group.turn !== null) {
      const reason = group.reason?.kind === 'completed' ? '完成 · 这一轮没有文字回答'
        : !group.reason ? '未结束 · 还没有最终回答'
          : turnEnding(group.reason) + (partial ? ' · 没有最终回答，中断前的部分输出在上面的过程里' : ' · 没有最终回答')
      section.append(node('p', reason, 'log-no-answer'))
    }
    return section
  }
  // 「全部展开 / 全部收起」 act on every turn's process fold at once.
  function setAllFolds(open) {
    for (const fold of $('session-log-turns').querySelectorAll('details.log-process')) fold.open = open
  }
  function renderConversation() {
    const grouped = groupConversation(events)
    renderOverview(grouped.overview)
    const sections = [grouped.opening, ...grouped.turns].map(renderGroup).filter(Boolean)
    $('session-log-turns').replaceChildren(...sections)
    $('session-log-timeline-empty').hidden = sections.length > 0
    const hidden = [grouped.opening, ...grouped.turns].reduce((sum, group) => sum + group.items.filter((item) => item.kind === 'internal').length, 0)
    $('session-log-loaded').textContent = `${number(events.length)} 条事件 · ${grouped.turns.length} 轮${showInternal ? '' : ` · 已隐藏 ${number(hidden)} 条内部事件`}${
      current.missingEvents ? ` · 缺 ${current.missingEvents} 条` : ''}`
  }

  // ── Overview ───────────────────────────────────────────────────────────────
  const SETTINGS = { 'permission/preset': '权限预设', 'sandbox/mode': '沙箱', 'approval/policy': '审批策略' }
  function renderOverview(overview) {
    const box = $('session-log-overview')
    box.replaceChildren()
    const facts = node('dl', '', 'log-facts')
    const fact = (name, value, className = '') => {
      if (value === null || value === undefined || value === '') return
      const wrap = node('div')
      const dd = document.createElement('dd')
      if (value instanceof Node) dd.append(value)
      else { dd.textContent = value; if (className) dd.className = className }
      wrap.append(node('dt', name, 'muted'), dd)
      facts.append(wrap)
    }
    fact('上报账号', current.accountId ? `${current.accountId}（客户端上报，未核验）` : '—')
    const keys = node('div')
    if (!current.keys.length) keys.append(node('span', '未带 Key（匿名）', 'muted'))
    for (const item of current.keys) {
      const line = node('div', '', 'session-log-key')
      keyLines(line, item)
      if (current.keys.length > 1) line.append(node('div', `首次 ${time(item.firstUsedAt)} · 最近 ${time(item.lastUsedAt)}`, 'muted'))
      keys.append(line)
    }
    fact(current.keys.length > 1 ? `Key（${current.keys.length} 把）` : 'Key', keys)
    fact('客户端', clientText(current.client))
    fact('目录', current.cwd, 'log-code')
    fact('创建', time(current.createdAt))
    fact('最近上传', time(current.lastReceivedAt))
    fact('模型', current.models.join('、') || '—')
    fact('累计 token', current.tokens.total ? `${number(current.tokens.total)}（输入 ${number(current.tokens.input)} · 输出 ${number(current.tokens.output)}）` : '—')
    box.append(facts)
    const chips = node('div', '', 'log-chips')
    for (const [type, label] of Object.entries(SETTINGS)) {
      if (overview.settings[type]) chips.append(node('span', `${label} ${overview.settings[type]}`, 'chip'))
    }
    const descriptor = overview.descriptor
    if (descriptor) chips.append(node('span', `子代理 ${[descriptor.label, descriptor.mode, [descriptor.agentProvider, descriptor.agentModel].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')}`, 'chip'))
    if (chips.childElementCount) box.append(chips)
    overview.systemPrompts.forEach((text, index) => {
      box.append(foldText(text, { lines: 0, code: true, label: overview.systemPrompts.length > 1 ? `系统提示词 ${index + 1}/${overview.systemPrompts.length}` : '系统提示词' }))
    })
  }

  // ── Raw JSON ───────────────────────────────────────────────────────────────
  // The text is built once per opened session and shown a piece at a time, so tens of megabytes
  // never land in the DOM at once.
  function rawText() {
    raw ??= rawDocument(header, events, current.formatVersion, current.id)
    return raw
  }
  function showMoreRaw() {
    const text = rawText()
    if (rawShown >= text.length) return
    let end = Math.min(text.length, rawShown + RAW_CHUNK)
    // End a piece at a line break; a single huge line (a long string value) is cut where it is.
    if (end < text.length) { const cut = text.indexOf('\n', end); if (cut !== -1 && cut - end < RAW_CHUNK) end = cut + 1 }
    $('session-log-raw-text').append(document.createTextNode(text.slice(rawShown, end)))
    rawShown = end
    const done = rawShown >= text.length
    $('session-log-raw-more').hidden = done
    $('session-log-raw-size').textContent = `${number(events.length)} 条事件 · ${size(text.length)}${done ? '' : ` · 已显示 ${size(rawShown)}，向下滚动继续`}`
  }
  function renderRaw() {
    if (rawShown) return
    $('session-log-raw-text').replaceChildren()
    showMoreRaw()
    observer?.disconnect()
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting) && tab === 'raw') showMoreRaw() }, { rootMargin: '600px' })
      observer.observe($('session-log-raw-sentinel'))
    }
  }
  async function download(format) {
    const response = await fetch(`/api/v1/session-logs/${encodeURIComponent(current.id)}/${current.formatVersion}/raw?format=${format}`,
      { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    if (!response.ok) {
      let message = '下载失败，请稍后重试。'
      try { message = (await response.json()).error || message } catch {}
      throw new Error(message)
    }
    const url = URL.createObjectURL(await response.blob())
    const link = node('a')
    link.href = url
    link.download = `${current.id}.${format}`
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  async function copy(text) {
    if (!navigator.clipboard?.writeText) throw new Error('浏览器不允许复制，请改用下载。')
    await navigator.clipboard.writeText(text)
  }
  function showJson(value) {
    let text = JSON.stringify(value, null, 2) ?? ''
    const full = text
    if (text.length > DIALOG_LIMIT) text = text.slice(0, DIALOG_LIMIT) + `\n…（共 ${size(full.length)}，只显示前 ${size(DIALOG_LIMIT)}；完整内容请用「复制」或下载）`
    $('session-log-json-text').textContent = text
    $('session-log-json-copy').onclick = () => action(() => copy(full), { success: '已复制。' })
    $('session-log-json-dialog').showModal()
  }

  // ── Tabs and loading ───────────────────────────────────────────────────────
  function selectTab(name) {
    tab = name
    for (const [id, value] of [['session-log-tab-conversation', 'conversation'], ['session-log-tab-raw', 'raw']]) {
      $(id).setAttribute('aria-pressed', String(value === name))
      $(id).setAttribute('aria-selected', String(value === name))
    }
    $('session-log-conversation').hidden = name !== 'conversation'
    $('session-log-raw').hidden = name !== 'raw'
    $('session-log-internal-row').hidden = name !== 'conversation'
    $('session-log-fold-row').hidden = name !== 'conversation'
    if (name === 'raw') renderRaw()
  }
  // Every page of the session, in order; only the first one is recorded as a read.
  async function loadAll(id, formatVersion) {
    let after = -1
    const loaded = []
    let first = null
    do {
      const result = await json(`/api/v1/session-logs/${encodeURIComponent(id)}/${formatVersion}?${new URLSearchParams({ after: String(after), limit: String(PAGE) })}`)
      first ??= result
      loaded.push(...result.events)
      after = result.next
      $('session-log-loaded').textContent = `读取中 ${number(loaded.length)} / ${number(result.session.eventCount)} 条事件…`
    } while (after !== null)
    return { ...first, events: loaded }
  }
  async function open(id, formatVersion) {
    const result = await loadAll(id, formatVersion)
    current = { ...result.session, keys: result.keys }
    header = result.header ?? null
    events = result.events
    openTurns.clear()
    raw = null
    rawShown = 0
    $('session-log-raw-text').replaceChildren()
    $('session-log-title').textContent = current.title || '未命名会话'
    $('session-log-meta').textContent = [current.id, `格式 v${current.formatVersion}`, current.parentSession ? '子代理会话' : ''].filter(Boolean).join(' · ')
    $('session-log-parent').hidden = !current.parentSession
    renderConversation()
    selectTab('conversation')
  }
  async function openBySession(sessionId, missing) {
    const found = await json('/api/v1/session-logs?' + new URLSearchParams({ session: sessionId }))
    if (!found.items.length) throw new Error(missing)
    await open(found.items[0].id, found.items[0].formatVersion)
    $('session-log-detail').scrollIntoView?.({ block: 'start' })
  }
  function close() {
    observer?.disconnect()
    current = null
    header = null
    events = []
    raw = null
    rawShown = 0
    $('session-log-turns').replaceChildren()
    $('session-log-overview').replaceChildren()
    $('session-log-raw-text').replaceChildren()
  }

  $('session-log-tab-conversation').onclick = () => selectTab('conversation')
  $('session-log-tab-raw').onclick = () => selectTab('raw')
  $('session-log-internal').onchange = () => { showInternal = $('session-log-internal').checked; renderConversation() }
  $('session-log-expand-all').onclick = () => setAllFolds(true)
  $('session-log-collapse-all').onclick = () => setAllFolds(false)
  $('session-log-raw-more').onclick = showMoreRaw
  $('session-log-download-json').onclick = () => action(() => download('json'), { success: 'JSON 已下载，已写入操作记录。' })
  $('session-log-download-jsonl').onclick = () => action(() => download('jsonl'), { success: 'JSONL 已下载，已写入操作记录。' })
  $('session-log-copy').onclick = () => action(() => copy(rawText()), { success: '整个会话的 JSON 已复制。' })
  $('session-log-json-close').onclick = () => $('session-log-json-dialog').close()
  $('session-log-back').onclick = onBack
  $('session-log-parent').onclick = () => action(() => openBySession(current.parentSession, '父会话的日志不在这里（可能未上传或已删除）。'))

  return { open, close, isOpen: () => current !== null }
}
