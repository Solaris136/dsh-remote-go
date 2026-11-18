// client/src/guest-host-row.ts - mountHostRow + HOST_ROW_SCRIPT, stringified into the remote page and self-contained (9b 2/11); after switcher.ts, before guest-tools.ts.
/**
 * The switcher row, stringified into the remote guest (`HOST_ROW_SCRIPT`): it may only touch
 * `win` and its own locals — any closure over this module breaks the guest copy. Intents leave
 * through `win.__drgBridgeSink` (local page) or `win.__drgBridgeQueue` (guest, drained by the
 * carrier); both copies therefore need identical intents and identical tokens.
 */
function mountHostRow(win: Window): string | unknown {
  try {
    var doc = win.document
    if (!doc || !doc.head) return 'no-document'
    var existing = win.__drgHostRow
    if (existing && typeof existing.update === 'function') return existing.update(null)

    // A guest has no callback channel, so it leaves intents in a queue the carrier
    // drains: a single slot would drop the first of two quick clicks.
    var emit =
      typeof win.__drgBridgeSink === 'function'
        ? win.__drgBridgeSink
        : function (intent: GuestIntentLike) {
            var queue = win.__drgBridgeQueue
            if (!queue || typeof queue.push !== 'function') queue = []
            queue.push(intent)
            win.__drgBridgeQueue = queue
          }

    var make = function (tag: string, className?: string) {
      var node = doc.createElement(tag)
      if (className) node.className = className
      return node
    }
    var style = win.__drgHostRowStyle || null
    if (style === null) {
      style = make('style')
      style.id = 'drg-host-row-style'
      win.__drgHostRowStyle = style
    }
    style.textContent = [
      // The row is drawn inside the host page, so it reads that page's --dsw-* aliases and
      // follows light/dark, a registered theme, or a token override layer unchanged. The
      // menu surface uses the same pair as the host's own menus (specific-menu + blur).
      '#drg-host-row{position:relative;z-index:2147483000;display:flex;align-items:center;gap:8px;margin:4px 8px 6px;padding:5px 8px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);font:500 12.5px/1.35 var(--dsw-font-family);cursor:pointer;user-select:none;transition:background-color 140ms ease,color 140ms ease}',
      '#drg-host-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '#drg-host-row.drg-open{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '#drg-host-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '#drg-host-row .drg-hr-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:currentColor;color:var(--dsw-alias-state-idle-primary)}',
      '#drg-host-row .drg-hr-dot[data-state="local"],#drg-host-row .drg-hr-dot[data-state="connected"]{color:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent),0 0 7px 0 color-mix(in srgb,currentColor 45%,transparent)}',
      '#drg-host-row .drg-hr-dot[data-state="connecting"]{color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent)}',
      '#drg-host-row .drg-hr-dot[data-state="fingerprint-pending"],#drg-host-row .drg-hr-dot[data-state="conflict-pending"]{color:var(--dsw-alias-state-warn-primary)}',
      '#drg-host-row .drg-hr-dot[data-state="error"],#drg-host-row .drg-hr-dot[data-state="limited"]{color:var(--dsw-alias-state-error-primary)}',
      '#drg-host-row .drg-hr-glyph{display:flex;align-items:center;justify-content:center;width:8px;flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font:500 12px/1 var(--dsw-font-family)}',
      '#drg-host-row .drg-hr-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#drg-host-row .drg-hr-chev{display:flex;flex:0 0 auto;color:var(--dsw-alias-label-tertiary);transition:transform 160ms ease}',
      '#drg-host-row.drg-open .drg-hr-chev{transform:rotate(180deg)}',
      // The row is a button, so the menu is a child of a pointer surface: the surface
      // itself (padding, separators, the slack around a short row) must not inherit the
      // hand, or the blank parts of the menu promise a click they do not have.
      '#drg-host-row .drg-hr-menu{display:none;position:fixed;z-index:2147483000;min-width:220px;max-height:min(60vh,420px);overflow:auto;padding:5px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);font-size:13px;cursor:default}',
      '#drg-host-row.drg-open .drg-hr-menu{display:block;animation:drg-hr-in 120ms ease-out}',
      '@keyframes drg-hr-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
      '#drg-host-row .drg-hr-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;overflow:hidden;transition:background-color 120ms ease,color 120ms ease}',
      '#drg-host-row .drg-hr-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '#drg-host-row .drg-hr-item[data-active="1"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}',
      '#drg-host-row .drg-hr-sep{height:.5px;margin:5px 6px;background:var(--dsw-alias-border-l1)}',
      // The name takes the slack, so the address and the exit control stay flush right.
      '#drg-host-row .drg-hr-item-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '#drg-host-row .drg-hr-addr{flex:0 0 auto;max-width:120px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
      // Text, not an icon, and only while the row is hovered: an accidental exit is a
      // worse outcome than a hidden control.
      '#drg-host-row .drg-hr-act{flex:0 0 auto;margin-left:2px;padding:2px 6px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity 120ms ease,background-color 120ms ease,color 120ms ease}',
      '#drg-host-row .drg-hr-item:hover .drg-hr-act,#drg-host-row .drg-hr-act:focus-visible{opacity:1;pointer-events:auto}',
      '#drg-host-row .drg-hr-act:hover,#drg-host-row .drg-hr-act:focus-visible{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '@media (prefers-reduced-motion:reduce){#drg-host-row,#drg-host-row *{transition:none!important;animation:none!important}}',
    ].join('')
    if (style.parentNode !== doc.head) doc.head.appendChild(style)

    var row = make('div')
    row.id = 'drg-host-row'
    row.setAttribute('role', 'button')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-haspopup', 'menu')
    row.setAttribute('aria-expanded', 'false')
    row.setAttribute('aria-controls', 'drg-host-row-menu')
    var dotNode = make('span', 'drg-hr-dot')
    dotNode.setAttribute('data-state', 'local')
    row.appendChild(dotNode)
    var nameNode = make('span', 'drg-hr-name')
    row.appendChild(nameNode)
    var chevNode = make('span', 'drg-hr-chev')
    // Built node by node (never innerHTML), so no host name or address needs escaping.
    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '12')
    svg.setAttribute('height', '12')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.7')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    var chevPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    chevPath.setAttribute('d', 'M4.2 6.4 8 10.2l3.8-3.8')
    svg.appendChild(chevPath)
    chevNode.appendChild(svg)
    row.appendChild(chevNode)
    var menuNode = make('span', 'drg-hr-menu')
    menuNode.id = 'drg-host-row-menu'
    menuNode.setAttribute('role', 'menu')
    row.appendChild(menuNode)

    var state: { current: string; hosts: SwitcherHost[]; labels: SwitcherLabels } = {
      current: 'local',
      hosts: [],
      labels: { local: 'Local', addHost: 'Add host', manage: 'Manage hosts', exit: 'Exit remote' },
    }

    var dotFor = function (status: string | null | undefined) {
      var node = make('span', 'drg-hr-dot')
      node.setAttribute('data-state', status || 'idle')
      return node
    }
    var itemFor = function (
      label: string,
      options?: {
        target?: string
        action?: string
        active?: boolean
        glyph?: string
        state?: string
        trailing?: string
        exit?: string
      },
    ) {
      var opts = options || {}
      var node = make('span', 'drg-hr-item')
      node.setAttribute('role', 'menuitem')
      // Roving focus: the menu itself is one Tab stop, arrows move between its items.
      node.setAttribute('tabindex', '-1')
      if (opts.target) node.setAttribute('data-target', opts.target)
      if (opts.action) node.setAttribute('data-action', opts.action)
      if (opts.active === true) node.setAttribute('data-active', '1')
      // An action gets a glyph where a target would carry its connection dot.
      if (opts.action) {
        var glyphNode = make('span', 'drg-hr-glyph')
        glyphNode.textContent = opts.glyph || '+'
        node.appendChild(glyphNode)
      } else {
        node.appendChild(dotFor(opts.state))
      }
      var textNode = make('span', 'drg-hr-item-name')
      textNode.textContent = label
      node.appendChild(textNode)
      if (opts.trailing) {
        var trailingNode = make('span', 'drg-hr-addr')
        trailingNode.textContent = opts.trailing
        node.appendChild(trailingNode)
      }
      // A live host carries its own exit control, on the same line, right-aligned and revealed on hover: switching
      // to a host and leaving it are different actions, and the menu had no way to leave one.
      if (opts.exit) {
        var exitLabel = state.labels.exit || 'Disconnect'
        var exitNode = make('button', 'drg-hr-act')
        exitNode.setAttribute('type', 'button')
        exitNode.setAttribute('data-action', 'disconnect')
        exitNode.setAttribute('data-host-id', opts.exit)
        exitNode.setAttribute('title', exitLabel + ' ' + label)
        exitNode.setAttribute('aria-label', exitLabel + ' ' + label)
        exitNode.textContent = exitLabel
        node.appendChild(exitNode)
      }
      return node
    }
    var clear = function (node: Element) {
      while (node.firstChild) node.removeChild(node.firstChild)
    }
    var render = function () {
      var active = null
      for (var index = 0; index < state.hosts.length; index += 1) {
        if (state.hosts[index] && state.hosts[index].id === state.current) {
          active = state.hosts[index]
          break
        }
      }
      var isLocal = state.current === 'local'
      nameNode.textContent = isLocal
        ? state.labels.local
        : active
          ? active.name || active.address || active.id
          : state.labels.local
      dotNode.setAttribute('data-state', isLocal ? 'local' : active ? active.status || 'idle' : 'idle')
      clear(menuNode)
      menuNode.appendChild(itemFor(state.labels.local, { target: 'local', state: 'local', active: isLocal }))
      for (var cursor = 0; cursor < state.hosts.length; cursor += 1) {
        var host = state.hosts[cursor]
        if (!host || typeof host.id !== 'string') continue
        var label = host.name || host.address || host.id
        var address = host.address && host.address !== label ? host.address : ''
        menuNode.appendChild(
          itemFor(label, {
            target: host.id,
            state: host.status || 'idle',
            active: host.id === state.current,
            trailing: address,
            exit: host.status === 'connected' ? host.id : '',
          }),
        )
      }
      menuNode.appendChild(make('span', 'drg-hr-sep'))
      menuNode.appendChild(itemFor(state.labels.addHost, { action: 'add', glyph: '+' }))
      menuNode.appendChild(itemFor(state.labels.manage, { action: 'manage', glyph: '\u2261' }))
    }
    /**
     * Find the sidebar column and the row the switcher belongs under: the drag-handle
     * brand row when the shell exposes one, otherwise the tall left column itself.
     */
    var findSlot = function () {
      var handles = doc.querySelectorAll('[data-window-drag]')
      var best = null
      for (var index = 0; index < handles.length; index += 1) {
        var box = handles[index].getBoundingClientRect()
        if (box.width <= 0 && box.height <= 0) continue
        // The sidebar brand is inset by its padding and near the top; the conversation
        // header and the tab strip are wide, so the width bound leaves only the brand.
        if (box.width > 520) continue
        if (box.top > win.innerHeight * 0.4) continue
        if (!handles[index].parentNode) continue
        var columnBox = (handles[index].parentNode as Element).getBoundingClientRect()
        if (columnBox.left > 24) continue
        if (columnBox.width < 180) continue
        // macOS puts a drag strip *above* the brand row, and both qualify: the lower one
        // is the row the switcher belongs under.
        if (best === null || box.top > best.top) {
          best = { column: handles[index].parentNode as Element, anchor: handles[index], top: box.top }
        }
      }
      if (best !== null) return { column: best.column, anchor: best.anchor }
      var columns = doc.querySelectorAll('div,aside,nav,section')
      var found = null
      for (var probe = 0; probe < columns.length; probe += 1) {
        var rect = columns[probe].getBoundingClientRect()
        if (rect.left > 2) continue
        if (rect.width < 180 || rect.width > 480) continue
        if (rect.height < win.innerHeight * 0.6) continue
        found = columns[probe]
        // The first matching column is the sidebar; a later full-height section is not a
        // better answer, and the old loop took the last one it saw.
        break
      }
      if (found === null) return null
      return { column: found, anchor: found.children.length > 0 ? found.children[0] : null }
    }
    /**
     * Put the row under `parent`, directly before `ref` (`null` appends).
     *
     * `insertBefore` on an already-connected node runs the DOM's remove-then-insert steps, and the
     * remove step is what costs the node its focus and resets its state: the row is a `tabindex=0`
     * button whose open menu is one of its children, so a shell that re-orders the sidebar (or
     * inserts a sibling above the brand) used to drop both - the menu stayed open but Esc stopped
     * reaching it. `moveBefore` is the specification's state-preserving move and lands the node in
     * the same place; it is not in every engine yet, so its absence - or an implementation that
     * refuses the move - falls through to exactly the insertion this code made before.
     */
    var moveRow = function (parent: Element, ref: Node | null) {
      if (typeof parent.moveBefore === 'function') {
        try {
          parent.moveBefore(row, ref)
          return
        } catch (_error) {
          // swallow-ok: a partial implementation must not cost the row its place; the fallback
          // below is the same insertion the pre-moveBefore code performed.
        }
      }
      if (ref === null) parent.appendChild(row)
      else parent.insertBefore(row, ref)
    }
    var place = function () {
      var slot = findSlot()
      if (slot === null) {
        // The collapsed rail is ~56px wide and no longer a candidate column: hide the
        // row instead of leaving it squeezed into it.
        // Node.parentNode is typed as ParentNode; the row only ever lives under an Element.
        var parent = row.parentNode as Element | null
        var parentBox = parent && parent.getBoundingClientRect ? parent.getBoundingClientRect() : null
        if (parentBox !== null && parentBox.width < 180) {
          row.style.display = 'none'
          return 'collapsed'
        }
        return 'no-anchor'
      }
      // The collapsed rail is 56px wide: the row belongs to the expanded column only.
      if (slot.column.getBoundingClientRect().width < 180) {
        row.style.display = 'none'
        return 'collapsed'
      }
      row.style.display = ''
      if (slot.anchor === null) {
        if (row.parentNode !== slot.column) moveRow(slot.column, null)
        return 'installed'
      }
      if (slot.anchor.nextSibling !== row) moveRow(slot.column, slot.anchor.nextSibling)
      return 'installed'
    }
    var closeMenu = function () {
      row.classList.remove('drg-open')
      row.setAttribute('aria-expanded', 'false')
    }
    var menuItems = function (): HTMLElement[] {
      return Array.prototype.slice.call(menuNode.querySelectorAll('.drg-hr-item'))
    }
    var focusItem = function (index: number) {
      var items = menuItems()
      if (items.length === 0) return
      var at = Math.max(0, Math.min(items.length - 1, index))
      var node = items[at]
      if (node && typeof node.focus === 'function') node.focus()
    }
    var openMenu = function (focusFirst: boolean) {
      // The sidebar clips its children: anchor the fixed menu to the row so it can
      // escape that overflow and sit over the page like a native menu.
      var rect = row.getBoundingClientRect()
      menuNode.style.top = rect.bottom + 4 + 'px'
      menuNode.style.left = rect.left + 'px'
      menuNode.style.width = rect.width + 'px'
      row.classList.add('drg-open')
      row.setAttribute('aria-expanded', 'true')
      if (focusFirst === true) focusItem(0)
    }
    row.addEventListener('click', function (event: GuestMouseEvent) {
      var target = event.target
      // A host's own exit control acts on that host without switching to it.
      if (target && target.classList && target.classList.contains('drg-hr-act')) {
        var exitHost = target.getAttribute('data-host-id')
        closeMenu()
        if (exitHost) emit({ action: 'disconnect', hostId: exitHost })
        return
      }
      while (target && target !== row && !(target.classList && target.classList.contains('drg-hr-item'))) {
        // The walk goes up through elements; parentNode is typed as ParentNode.
        target = target.parentNode as Element | null
      }
      if (target && target !== row && target.classList && target.classList.contains('drg-hr-item')) {
        var targetId = target.getAttribute('data-target')
        var action = target.getAttribute('data-action')
        closeMenu()
        if (action) emit({ action: action })
        else if (targetId) emit({ target: targetId })
        return
      }
      if (row.classList.contains('drg-open')) {
        closeMenu()
        return
      }
      openMenu(false)
    })
    // Keyboard parity (audit "host row unreachable by keyboard"): the row is a real button,
    // Enter/Space opens it, arrows walk the menu, Escape closes and returns focus to the row.
    row.addEventListener('keydown', function (event: GuestKeyboardEvent) {
      var key = event.key
      var focusTarget = event.target
      // A real button inside the row keeps its native Enter/Space activation.
      if (focusTarget && focusTarget.classList && focusTarget.classList.contains('drg-hr-act')) return
      var items = menuItems()
      var active = doc.activeElement
      var index = items.indexOf(active as HTMLElement | null)
      var opened = row.classList.contains('drg-open')
      if (key === 'Enter' || key === ' ') {
        event.preventDefault()
        if (index >= 0) {
          // The items are spans: activate the focused one exactly like a click.
          var node = items[index]
          if (typeof node.click === 'function') node.click()
          return
        }
        if (opened) closeMenu()
        else openMenu(true)
        return
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        if (!opened) {
          event.preventDefault()
          openMenu(true)
          if (key === 'ArrowUp') focusItem(menuItems().length - 1)
          return
        }
        if (items.length === 0) return
        event.preventDefault()
        if (index < 0) {
          focusItem(key === 'ArrowDown' ? 0 : items.length - 1)
          return
        }
        var step = key === 'ArrowDown' ? 1 : -1
        focusItem((index + step + items.length) % items.length)
        return
      }
      if (key === 'Home' || key === 'End') {
        if (!opened) return
        event.preventDefault()
        focusItem(key === 'Home' ? 0 : items.length - 1)
        return
      }
      if (key === 'Escape' && opened) {
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        if (typeof row.focus === 'function') row.focus()
      }
    })
    var outsideClick = function (event: GuestMouseEvent) {
      if (row.contains && row.contains(event.target)) return
      closeMenu()
    }
    doc.addEventListener('click', outsideClick)
    var update = function (payload: SwitcherPayload | null | undefined) {
      if (payload && typeof payload === 'object') {
        if (Object.prototype.toString.call(payload.hosts) === '[object Array]') state.hosts = payload.hosts
        if (typeof payload.current === 'string' && payload.current.length > 0) state.current = payload.current
        if (payload.labels && typeof payload.labels === 'object') {
          state.labels = {
            local: String(payload.labels.local || state.labels.local),
            addHost: String(payload.labels.addHost || state.labels.addHost),
            manage: String(payload.labels.manage || state.labels.manage),
            exit: String(payload.labels.exit || state.labels.exit),
          }
        }
      }
      var status = place()
      if (status !== 'installed') return status
      render()
      return status
    }
    win.__drgHostRow = {
      update: update,
      destroy: function () {
        closeMenu()
        if (typeof doc.removeEventListener === 'function') doc.removeEventListener('click', outsideClick)
        if (row.parentNode) row.parentNode.removeChild(row)
        if (style.parentNode) style.parentNode.removeChild(style)
        win.__drgHostRow = null
        win.__drgHostRowStyle = null
      },
    }
    // A sidebar that is not mounted yet (or is collapsed) still gets its handle: the
    // caller's next push places the row the moment the column exists.
    return update(null)
  } catch (_error) {
    return 'error'
  }
}

const HOST_ROW_SCRIPT = '(' + mountHostRow.toString() + ')(window)'
