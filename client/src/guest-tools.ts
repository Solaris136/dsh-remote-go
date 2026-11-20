// client/src/guest-tools.ts - mountGuestTools/mountCapabilityBridge and the two guest scripts they become; after guest-host-row.ts, before guest-storage.ts.
// i18n-exempt: this function is serialized into the remote page, which cannot reach the host's t() or its dictionary.
/** A desktop guest cancels Chromium downloads; this keeps the menu and turns the row's path into an SFTP intent. */
// It only touches `win` and its locals, since the script is stringified into the guest.
function mountGuestTools(win: Window): string {
  try {
    var doc = win.document
    if (!doc || !doc.documentElement) return 'no-document'
    if (win.__drgGuestTools === true) return 'already'
    // Install flag last: setting it first made a half-installed page permanent, because the retry answered "already".
    var emit: (intent: GuestIntentLike) => IntentReceipt | boolean | undefined | void =
      typeof win.__drgBridgeSink === 'function'
        ? win.__drgBridgeSink
        : function (intent: GuestIntentLike) {
            var queue = win.__drgBridgeQueue
            if (!queue || typeof queue.push !== 'function') queue = []
            queue.push(intent)
            win.__drgBridgeQueue = queue
          }
    var lastFile: { kind: string; path: string; name: string } | null = null
    // The icon is the stable hook; the labels fall back for a rename (the file-action plugin ships eight languages).
    var DOWNLOAD_LABELS = [
      '下载',
      'Download',
      'ダウンロード',
      '다운로드',
      'Скачать',
      'Descargar',
      'Télécharger',
      'Herunterladen',
      'Baixar',
    ]
    var clear = function () {
      lastFile = null
    }
    var restoreMenus = function () {
      var hidden = doc.querySelectorAll<HTMLElement>('[data-drg-guest-hidden]')
      for (var index = 0; index < hidden.length; index += 1) {
        hidden[index].style.display = ''
        hidden[index].removeAttribute('data-drg-guest-hidden')
      }
      var stale = doc.querySelectorAll<HTMLElement>('[data-drg-dir-download-wrap]')
      for (var staleIndex = 0; staleIndex < stale.length; staleIndex += 1) {
        if (stale[staleIndex].parentNode) stale[staleIndex].parentNode.removeChild(stale[staleIndex])
      }
    }
    var hideMenus = function () {
      // The capture ate the menu's own select handler: hide the surface and its backing instead of replaying a click.
      // A hidden node cannot eat the next gesture, and the next context menu restores it.
      try {
        var marked = doc.querySelectorAll<HTMLElement>('[role="menu"][data-context-menu], [data-menu-backing]')
        for (var menuIndex = 0; menuIndex < marked.length; menuIndex += 1) {
          marked[menuIndex].setAttribute('data-drg-guest-hidden', '1')
          marked[menuIndex].style.display = 'none'
        }
      } catch (_error) {
        // swallow-ok: the menu also closes on the next pointer gesture
      }
    }
    var directoryTimer: number | null = null
    /** A directory has no native download item, so append one to the context menu, cloned from the template. */
    // React owns the menu; the appended wrapper is removed again on the next context menu.
    var addDirectoryItem = function () {
      if (!lastFile || lastFile.kind !== 'directory') return true
      var menu = doc.querySelector('[role="menu"][data-context-menu]')
      if (!menu) return false
      if (menu.querySelector('[data-drg-dir-download]')) return true
      var template = menu.querySelector('button[role="menuitem"]')
      if (!template) return false
      var wrapper = template.parentElement
      // cloneNode is typed as Node; the menu item it copies is a button.
      var clone = (wrapper && wrapper !== menu ? wrapper : template).cloneNode(true) as HTMLButtonElement
      var item = clone.tagName === 'BUTTON' ? clone : clone.querySelector<HTMLButtonElement>('[role="menuitem"]')
      if (!item) return false
      item.removeAttribute('id')
      item.disabled = false
      item.removeAttribute('aria-disabled')
      item.setAttribute('data-drg-dir-download', '1')
      var lang = String(
        doc.documentElement.getAttribute('lang') || (win.navigator && win.navigator.language) || '',
      ).toLowerCase()
      var label = lang.indexOf('zh') === 0 ? '下载到本地' : 'Download to this computer'
      var leaf = null
      var spans = item.querySelectorAll<HTMLElement>('span')
      for (var spanIndex = spans.length - 1; spanIndex >= 0; spanIndex -= 1) {
        if (!spans[spanIndex].querySelector('svg') && spans[spanIndex].children.length === 0) {
          leaf = spans[spanIndex]
          break
        }
      }
      if (leaf) leaf.textContent = label
      else item.setAttribute('aria-label', label)
      var oldIcon = item.querySelector('svg')
      if (oldIcon && oldIcon.parentNode) {
        var ns = 'http://www.w3.org/2000/svg'
        var icon = doc.createElementNS(ns, 'svg')
        icon.setAttribute('width', '16')
        icon.setAttribute('height', '16')
        icon.setAttribute('viewBox', '0 0 24 24')
        icon.setAttribute('fill', 'none')
        icon.setAttribute('stroke', 'currentColor')
        icon.setAttribute('stroke-width', '1.7')
        icon.setAttribute('stroke-linecap', 'round')
        icon.setAttribute('stroke-linejoin', 'round')
        icon.setAttribute('aria-hidden', 'true')
        var iconPath = doc.createElementNS(ns, 'path')
        iconPath.setAttribute('d', 'M12 3v12m0 0 4-4m-4 4-4-4M4 19h16')
        icon.appendChild(iconPath)
        oldIcon.parentNode.replaceChild(icon, oldIcon)
      }
      clone.setAttribute('data-drg-dir-download-wrap', '1')
      var addedFor = lastFile
      clone.addEventListener(
        'click',
        function (event: GuestMouseEvent) {
          if (!addedFor || addedFor.kind !== 'directory') return
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          clear()
          emit({ action: 'download-file', kind: 'directory', path: addedFor.path, name: addedFor.name || '' })
          hideMenus()
        },
        true,
      )
      if (wrapper && wrapper !== menu && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(clone, wrapper.nextSibling)
      } else {
        menu.appendChild(clone)
      }
      return true
    }
    var queueDirectoryItem = function () {
      if (directoryTimer !== null) return
      var tries = 0
      var attempt = function () {
        directoryTimer = null
        if (!lastFile || lastFile.kind !== 'directory') return
        if (addDirectoryItem()) return
        tries += 1
        if (tries < 20) {
          directoryTimer = typeof win.setTimeout === 'function' ? win.setTimeout(attempt, 40) : setTimeout(attempt, 40)
        }
      }
      attempt()
    }
    var remember = function (target: (EventTarget & Element) | null) {
      restoreMenus()
      lastFile = null
      if (!target || typeof target.closest !== 'function') return
      var row = target.closest('li[data-files-entry][data-files-path]')
      if (!row) return
      var kind = row.getAttribute('data-files-entry')
      if (kind !== 'file' && kind !== 'directory') return
      var path = row.getAttribute('data-files-path') || ''
      if (path.charAt(0) !== '/') return
      var name = row.getAttribute('data-files-name') || ''
      if (!name) {
        var label = row.querySelector ? row.querySelector('button') : null
        name = label && label.textContent ? String(label.textContent).trim() : path.split('/').pop() || ''
      }
      lastFile = { kind: kind, path: path, name: name }
      if (kind === 'directory') queueDirectoryItem()
    }
    var interceptDownload = function (item: HTMLButtonElement | null, event: GuestMouseEvent | GuestKeyboardEvent) {
      if (!item || !lastFile || lastFile.kind !== 'file') return
      if (item.hasAttribute('data-drg-dir-download')) return
      if (item.disabled === true || item.getAttribute('aria-disabled') === 'true') return
      var icon = item.querySelector ? item.querySelector('svg[data-icon="dsw-icon-download-outline-regular"]') : null
      var label = String(item.textContent || '').trim()
      if (!icon && DOWNLOAD_LABELS.indexOf(label) < 0) return
      var file = lastFile
      clear()
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      emit({ action: 'download-file', kind: 'file', path: file.path, name: file.name || '' })
      hideMenus()
    }
    doc.addEventListener(
      'contextmenu',
      function (event: GuestMouseEvent) {
        remember(event.target)
      },
      true,
    )
    doc.addEventListener(
      'keydown',
      function (event: GuestKeyboardEvent) {
        if (event.key === 'ContextMenu' || (event.shiftKey === true && event.key === 'F10')) {
          remember(event.target)
          return
        }
        if (event.key === 'Escape') {
          clear()
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          var keyboardTarget = event.target
          var keyboardItem =
            keyboardTarget && typeof keyboardTarget.closest === 'function'
              ? keyboardTarget.closest<HTMLButtonElement>('[role="menuitem"]')
              : null
          if (keyboardItem) interceptDownload(keyboardItem, event)
        }
      },
      true,
    )
    // Capture phase, else the page's menu reads the file itself and hands a Blob to a download Chromium refuses.
    doc.addEventListener(
      'click',
      function (event: GuestMouseEvent) {
        var target = event.target
        if (!target || typeof target.closest !== 'function') return
        interceptDownload(target.closest<HTMLButtonElement>('[role="menuitem"]'), event)
      },
      true,
    )
    doc.addEventListener(
      'click',
      function () {
        // Runs after the interception listener: any click ends the file gesture (the download branch cleared it first).
        clear()
      },
      true,
    )
    win.__drgGuestTools = true
    return 'installed'
  } catch (_error) {
    return 'error'
  }
}

const GUEST_TOOLS_SCRIPT = '(' + mountGuestTools.toString() + ')(window)'
/** The guest half of the capability bridge: a subdocument keeps this origin's DOM but not the top-level powers. */
// Clipboard writes are refused and a popup has no handler, so this turns them into intents on the row's channel
// (`__drgBridgeSink`, else `__drgBridgeQueue`) and answers the clipboard one through `__drgCapabilityReply`.
function mountCapabilityBridge(win: Window): string {
  try {
    var doc = win.document
    if (!doc || !doc.documentElement) return 'no-document'
    if (win.__drgCapabilityBridge === true) return 'already'
    var PromiseCtor: PromiseConstructor = typeof win.Promise === 'function' ? win.Promise : Promise
    var emit: (intent: GuestIntentLike) => IntentReceipt | boolean | undefined =
      typeof win.__drgBridgeSink === 'function'
        ? win.__drgBridgeSink
        : function (intent: GuestIntentLike) {
            var queue = win.__drgBridgeQueue
            if (!queue || typeof queue.push !== 'function') queue = []
            queue.push(intent)
            win.__drgBridgeQueue = queue
            return null
          }
    var UrlCtor = typeof win.URL === 'function' ? win.URL : URL
    // Absolute http(s), a host, no credentials: only that leaves the frame; javascript:, data:, blob: stay inside.
    var externalUrl = function (value: unknown): string | null {
      if (typeof value !== 'string' || value === '' || value.length > 8192) return null
      var url = null
      try {
        url = new UrlCtor(value)
      } catch (_error) {
        return null
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (!url.hostname) return null
      if (url.username !== '' || url.password !== '') return null
      return url.href
    }
    var originOf = function (): string | null {
      try {
        return win.location && win.location.origin ? win.location.origin : null
      } catch (_error) {
        return null
      }
    }

    // --- clipboard: the top half performs the write, this half reports the answer ----------
    var pending: Record<
      string,
      { resolve: (value: boolean) => void; reject: (error: unknown) => void; timer: number | null }
    > = {}
    var sequence = 0
    var settle = function (id: string, result: GuestReceipt | null | undefined) {
      var entry = pending[id]
      if (!entry) return false
      delete pending[id]
      if (entry.timer !== null && typeof win.clearTimeout === 'function') win.clearTimeout(entry.timer)
      if (result && result.ok === true) entry.resolve(true)
      else entry.reject(new Error((result && typeof result.reason === 'string' && result.reason) || 'bridge'))
      return true
    }
    // The desktop carrier cannot reach into the guest, so it answers through this slot.
    win.__drgCapabilityReply = function (payload: GuestReceipt | null | undefined) {
      if (!payload || typeof payload !== 'object') return false
      return settle(String(payload.id === undefined || payload.id === null ? '' : payload.id), payload)
    }
    var ask = function (intent: GuestIntentLike & { id?: string }, timeoutMs: number) {
      return new PromiseCtor(function (resolve, reject) {
        sequence += 1
        var id = 'drg' + String(sequence)
        intent.id = id
        pending[id] = { resolve: resolve, reject: reject, timer: null }
        if (typeof win.setTimeout === 'function') {
          pending[id].timer = win.setTimeout(function () {
            settle(id, { ok: false, reason: 'timeout' })
          }, timeoutMs)
        }
        var answer = null
        try {
          answer = emit(intent)
        } catch (_error) {
          answer = null
        }
        // The browser carrier calls this module directly and answers with the write's promise.
        if (answer && typeof answer === 'object' && typeof answer.then === 'function') {
          answer.then(
            function (result: GuestReceipt) {
              settle(id, result)
            },
            function () {
              settle(id, { ok: false })
            },
          )
        }
      })
    }
    // The frame is the clicked document, so the legacy path still lands the text if the top half refuses.
    var legacyCopy = function (text: string) {
      try {
        if (!doc.body || typeof doc.execCommand !== 'function') return false
        var area = doc.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        doc.body.appendChild(area)
        area.select()
        var ok = doc.execCommand('copy')
        doc.body.removeChild(area)
        return ok === true
      } catch (_error) {
        return false
      }
    }
    var clipboard = null
    try {
      clipboard = win.navigator && win.navigator.clipboard ? win.navigator.clipboard : null
    } catch (_error) {
      clipboard = null
    }
    if (clipboard !== null && typeof clipboard.writeText === 'function') {
      var bridgeWriteText = function (text: unknown) {
        var value = text === undefined || text === null ? '' : String(text)
        return ask({ action: 'clipboard-write', text: value }, 4000).then(
          function (): undefined {
            return undefined
          },
          function (): undefined {
            if (legacyCopy(value)) return undefined
            try {
              emit({ action: 'notify', tone: 'error', code: 'clipboard-failed' })
            } catch (_error) {
              // swallow-ok: the local half may be gone; the clipboard error is thrown right below
            }
            throw new Error('clipboard-write-failed')
          },
        )
      }
      try {
        Object.defineProperty(clipboard, 'writeText', {
          configurable: true,
          writable: true,
          value: bridgeWriteText,
        })
      } catch (_error) {
        try {
          clipboard.writeText = bridgeWriteText
        } catch (_error2) {
          // swallow-ok: a frozen Clipboard object keeps its own writeText, which still works
        }
      }
    }

    // --- links: capture a real external click before the page's own handler swallows it ------
    var onLinkClick = function (event: GuestMouseEvent) {
      if (!event || event.defaultPrevented === true) return
      // A modified or non-primary click wants the browser's behaviour: leave it to the page, like `openExternalLink`.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      var target = event.target
      if (!target || typeof target.closest !== 'function') return
      // The file menu's download entry is this plugin's own control, never a navigation.
      if (target.closest('[data-drg-dir-download]')) return
      var anchor = target.closest('a[href]')
      if (!anchor || typeof anchor.getAttribute !== 'function') return
      // A `download` anchor keeps its native behaviour: a blob: URL is already refused below.
      if (typeof anchor.hasAttribute === 'function' && anchor.hasAttribute('download')) return
      var raw = anchor.getAttribute('href')
      if (typeof raw !== 'string' || raw === '') return
      var resolved = null
      try {
        resolved = new UrlCtor(raw, doc.baseURI || originOf() + '/')
      } catch (_error) {
        return
      }
      var url = externalUrl(resolved.href)
      if (url === null) return
      // A same-origin link belongs to the framed app (the DSH router): a new tab would open it with no row.
      var origin = originOf()
      if (origin !== null && resolved.origin === origin) return
      event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      try {
        emit({ action: 'open-external', url: url })
      } catch (_error) {
        // swallow-ok: the local half may be gone; the link still opens natively
      }
    }
    doc.addEventListener('click', onLinkClick, true)
    // --- window.open: a resolved web URL belongs to the top-level document --------------------
    var nativeOpen: Window['open'] | null = typeof win.open === 'function' ? win.open : null
    try {
      win.open = function (url?: string | URL, name?: string, features?: string) {
        var raw = typeof url === 'string' ? url : url === undefined || url === null ? '' : String(url)
        var target = externalUrl(raw)
        if (target === null) {
          // `about:blank` is the login popup with no URL, so it keeps the native call (the frame allows popups).
          if (nativeOpen === null) return null
          try {
            return nativeOpen.call(win, url, name, features)
          } catch (_error) {
            return null
          }
        }
        try {
          emit({ action: 'open-external', url: target })
        } catch (_error) {
          // swallow-ok: the local half may be gone; the popup was already handled
        }
        return null
      }
    } catch (_error) {
      // swallow-ok: a frozen window.open keeps the native one, which still opens the tab
    }
    // Claim the bridge only when every shim is in place, else a half-installed page answers `already` forever.
    win.__drgCapabilityBridge = true
    return 'installed'
  } catch (_error) {
    return 'error'
  }
}

const CAPABILITY_BRIDGE_SCRIPT = '(' + mountCapabilityBridge.toString() + ')(window)'
