/**
 * The console's Tabler building blocks, made from DOM nodes so every piece of data is placed with
 * textContent: buttons, a row's actions (one primary button plus a 「更多」 dropdown), badges and the
 * pager every paged list shares. The dropdown is Bootstrap's, from tabler.min.js, driven by its
 * data attributes; it is positioned `fixed` so a scrolling table never clips the menu.
 */
const CONTROLS = 'button,input,textarea,select'

/**
 * Disables only the given elements while one change is saved: a button (drawn as loading) or a
 * whole dialog or form (every control in it). Returns release(), which puts each control back the
 * way it was, or null when one of them is already locked -- the second click on a pending button
 * does nothing. An empty list locks nothing, for reads that must not hold up the page.
 */
export function lockControls(roots) {
  const list = [roots].flat().filter(Boolean)
  if (list.some((root) => root.dataset?.pending)) return null
  const controls = new Map()
  for (const root of list) {
    root.dataset.pending = 'true'
    for (const el of root.matches?.(CONTROLS) ? [root] : [...(root.querySelectorAll?.(CONTROLS) ?? [])]) controls.set(el, el.disabled)
    if (root.matches?.('button')) root.classList.add('btn-loading')
    root.setAttribute?.('aria-busy', 'true')
  }
  controls.forEach((_, el) => { el.disabled = true })
  return () => {
    controls.forEach((disabled, el) => { el.disabled = disabled })
    for (const root of list) {
      delete root.dataset.pending
      root.classList?.remove('btn-loading')
      root.removeAttribute?.('aria-busy')
    }
  }
}

/**
 * For reads that may be fired again before the last one answers (filters, pages, opening a
 * session): each call of `next()` starts a new turn, and `current(turn)` says whether it is still
 * the latest, so an answer that arrives late is dropped instead of replacing a newer one.
 */
export function latestOnly() {
  let latest = 0
  return { next: () => ++latest, current: (turn) => turn === latest }
}

export function consoleKit({ isBusy }) {
  const node = (tag, text = '', className = '') => {
    const el = document.createElement(tag)
    el.textContent = text
    el.className = className
    return el
  }
  const button = (label, handler, className = 'btn') => {
    const el = node('button', label, className)
    el.type = 'button'
    el.onclick = () => {
      if (!isBusy()) handler()
    }
    return el
  }
  const badge = (text, color = 'secondary') => node('span', text, `badge bg-${color}-lt`)

  /**
   * `primary` is { label, run, className? } or null; `more` lists { label, run, danger? }, with
   * 'divider' between groups. `name` labels the controls for assistive technology.
   */
  function rowActions(name, primary, more = []) {
    const box = node('div', '', 'btn-list flex-nowrap justify-content-end')
    if (primary) {
      const main = button(primary.label, primary.run, primary.className || 'btn')
      main.setAttribute('aria-label', `${name} ${primary.label}`)
      box.append(main)
    }
    if (more.length) {
      const wrap = node('div', '', 'dropdown')
      const toggle = node('button', '更多', 'btn dropdown-toggle')
      toggle.type = 'button'
      toggle.dataset.bsToggle = 'dropdown'
      toggle.dataset.bsPopperConfig = '{"strategy":"fixed"}'
      toggle.setAttribute('aria-expanded', 'false')
      toggle.setAttribute('aria-label', `${name} 更多操作`)
      const menu = node('div', '', 'dropdown-menu dropdown-menu-end')
      for (const item of more) {
        if (item === 'divider') {
          menu.append(node('div', '', 'dropdown-divider'))
          continue
        }
        const entry = button(item.label, item.run, 'dropdown-item' + (item.danger ? ' text-danger' : ''))
        entry.setAttribute('aria-label', `${name} ${item.label}`)
        menu.append(entry)
      }
      wrap.append(toggle, menu)
      box.append(wrap)
    }
    return box
  }

  /**
   * 「第 x-y 个 · 共 N 个」 on the left, then 「‹ 1 … 4 5 [6] 7 8 … 20 ›」 and the page size. Rebuilt
   * from scratch on every load, so no disabled state left behind by an action() survives.
   */
  function pager({ info, list, size, page, pageSize, total, unit, go }) {
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const first = total ? (page - 1) * pageSize + 1 : 0
    info.textContent = `第 ${first}-${Math.min(total, page * pageSize)} ${unit} · 共 ${total} ${unit}`
    const item = (label, target, { current = false, disabled = false, aria = label } = {}) => {
      const li = node('li', '', 'page-item' + (current ? ' active' : '') + (disabled ? ' disabled' : ''))
      const link = button(label, () => go(target), 'page-link')
      link.disabled = disabled
      link.setAttribute('aria-label', aria)
      if (current) link.setAttribute('aria-current', 'page')
      li.append(link)
      return li
    }
    const numbers = new Set([1, pages])
    for (let n = page - 2; n <= page + 2; n++) if (n >= 1 && n <= pages) numbers.add(n)
    const items = [item('‹', page - 1, { disabled: page <= 1, aria: '上一页' })]
    let last = 0
    for (const n of [...numbers].sort((a, b) => a - b)) {
      if (n - last > 1) {
        const gap = node('li', '', 'page-item disabled')
        gap.append(node('span', '…', 'page-link'))
        items.push(gap)
      }
      items.push(item(String(n), n, { current: n === page, aria: `第 ${n} 页` }))
      last = n
    }
    items.push(item('›', page + 1, { disabled: page >= pages, aria: '下一页' }))
    list.replaceChildren(...items)
    size.value = String(pageSize)
  }

  /**
   * The console's confirmation, in place of the browser's confirm(): Tabler's modal on the shared
   * native <dialog id="confirm-dialog">. Resolves true only for the confirm button; cancel, Esc or
   * closing it any other way resolve false. Focus starts on 取消, so Enter never confirms by accident.
   * `danger` (the default) draws the red status bar and button.
   */
  function confirmAction({ title, text, ok = '确认', danger = true }) {
    const dialog = document.getElementById('confirm-dialog')
    document.getElementById('confirm-title').textContent = title
    document.getElementById('confirm-text').textContent = text
    const okButton = document.getElementById('confirm-ok')
    okButton.textContent = ok
    okButton.className = danger ? 'btn btn-danger' : 'btn btn-primary'
    document.getElementById('confirm-status').className = `modal-status ${danger ? 'bg-danger' : 'bg-primary'}`
    return new Promise((resolve) => {
      dialog.returnValue = ''
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true })
      dialog.showModal()
      document.getElementById('confirm-cancel').focus()
    })
  }

  return { node, button, badge, rowActions, pager, confirmAction }
}
