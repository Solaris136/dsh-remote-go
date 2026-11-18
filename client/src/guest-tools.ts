// client/src/guest-tools.ts - mountGuestTools/mountCapabilityBridge and the two guest scripts they become (9b 3/11); after guest-host-row.ts, before guest-storage.ts.
// i18n-exempt: this function is serialized into the remote page, which cannot reach the host's t() or its dictionary.
/**
 * The remote DSH page's file menu already offers "Download", but a desktop
 * guest session explicitly cancels Chromium downloads. This injected script
 * keeps the page's own menu and, when its download item is chosen, turns the
 * file row's absolute path into an intent the local half can fetch over SFTP.
 * It only touches `win` and its locals (the script is stringified into the guest).
 */
function mountGuestTools(win) {
  try {
    var doc = win.document
    if (!doc || !doc.documentElement) return 'no-document'
    if (win.__drgGuestTools === true) return 'already'
    // The installed flag is set only once every listener is in place: setting it first made
    // a partial install permanent, because the retry then answered "already" (audit).
    var emit =
      typeof win.__drgBridgeSink === 'function'
        ? win.__drgBridgeSink
        : function (intent) {
            var queue = win.__drgBridgeQueue
            if (!queue || typeof queue.push !== 'function') queue = []
            queue.push(intent)
            win.__drgBridgeQueue = queue
          }
    var lastFile = null
    // The icon is the stable hook; the labels are a fallback for a future icon
    // rename (the eight languages shipped by the file-action plugin).
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
      var hidden = doc.querySelectorAll('[data-drg-guest-hidden]')
      for (var index = 0; index < hidden.length; index += 1) {
        hidden[index].style.display = ''
        hidden[index].removeAttribute('data-drg-guest-hidden')
      }
      var stale = doc.querySelectorAll('[data-drg-dir-download-wrap]')
      for (var staleIndex = 0; staleIndex < stale.length; staleIndex += 1) {
        if (stale[staleIndex].parentNode) stale[staleIndex].parentNode.removeChild(stale[staleIndex])
      }
    }
    var hideMenus = function () {
      // The page's menu closes from its own select handler, which the capture below
      // suppressed. Hide the menu surface (and its backing) instead of replaying a
      // synthetic click: a hidden node cannot eat the next gesture, and the next
      // context menu restores it before the page opens it again.
      try {
        var menus = doc.querySelectorAll('[role="menu"][data-context-menu]')
        for (var menuIndex = 0; menuIndex < menus.length; menuIndex += 1) {
          menus[menuIndex].setAttribute('data-drg-guest-hidden', '1')
          menus[menuIndex].style.display = 'none'
        }
        var backings = doc.querySelectorAll('[data-menu-backing]')
        for (var backingIndex = 0; backingIndex < backings.length; backingIndex += 1) {
          backings[backingIndex].setAttribute('data-drg-guest-hidden', '1')
          backings[backingIndex].style.display = 'none'
        }
      } catch (_error) {
        /* the menu also closes on the next pointer gesture */
      }
    }
    var directoryTimer = null
    /**
     * A directory has no native download item, so append one to the context menu.
     * React owns the menu but the appended wrapper uses the cloned item's classes;
     * the wrapper is removed again on the next context menu.
     */
    var addDirectoryItem = function () {
      if (!lastFile || lastFile.kind !== 'directory') return true
      var menu = doc.querySelector('[role="menu"][data-context-menu]')
      if (!menu) return false
      if (menu.querySelector('[data-drg-dir-download]')) return true
      var template = menu.querySelector('button[role="menuitem"]')
      if (!template) return false
      var wrapper = template.parentElement
      var clone = (wrapper && wrapper !== menu ? wrapper : template).cloneNode(true)
      var item = clone.tagName === 'BUTTON' ? clone : clone.querySelector('[role="menuitem"]')
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
      var spans = item.querySelectorAll('span')
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
        function (event) {
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
    var remember = function (target) {
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
    var interceptDownload = function (item, event) {
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
      function (event) {
        remember(event.target)
      },
      true,
    )
    doc.addEventListener(
      'keydown',
      function (event) {
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
              ? keyboardTarget.closest('[role="menuitem"]')
              : null
          if (keyboardItem) interceptDownload(keyboardItem, event)
        }
      },
      true,
    )
    // Capture phase: the page's React menu would otherwise read the file itself
    // and hand a Blob to a download Chromium refuses for a guest session.
    doc.addEventListener(
      'click',
      function (event) {
        var target = event.target
        if (!target || typeof target.closest !== 'function') return
        interceptDownload(target.closest('[role="menuitem"]'), event)
      },
      true,
    )
    doc.addEventListener(
      'click',
      function () {
        // Runs after the interception listener above: any click ends the file
        // gesture (the download branch already cleared it before emitting).
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
/**
 * The guest half of the capability bridge. A same-origin subdocument keeps this origin's DOM
 * access but not the browser capabilities a top-level document owns: clipboard writes are
 * refused (`Document is not focused` / `Write permission denied`) and a popup has no handler,
 * so a copy button and a link silently do nothing. This script turns those three requests into
 * intents on the channel the switcher row already uses — `__drgBridgeSink` when the carrier can
 * call back directly, the `__drgBridgeQueue` the desktop carrier drains otherwise — and answers
 * the clipboard one through `__drgCapabilityReply`, so the page can show ✓ or fail visibly.
 * It only touches `win` and its own locals (the script is stringified into the guest).
 */
function mountCapabilityBridge(win) {
  try {
    var doc = win.document
    if (!doc || !doc.documentElement) return 'no-document'
    if (win.__drgCapabilityBridge === true) return 'already'
    var PromiseCtor = typeof win.Promise === 'function' ? win.Promise : Promise
    var emit =
      typeof win.__drgBridgeSink === 'function'
        ? win.__drgBridgeSink
        : function (intent) {
            var queue = win.__drgBridgeQueue
            if (!queue || typeof queue.push !== 'function') queue = []
            queue.push(intent)
            win.__drgBridgeQueue = queue
            return null
          }
    var UrlCtor = typeof win.URL === 'function' ? win.URL : URL
    // A URL that may leave the frame: absolute http(s), a host, no credentials. Anything else
    // (javascript:, data:, blob:, a relative path) stays inside the framed page.
    var externalUrl = function (value) {
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
    var originOf = function () {
      try {
        return win.location && win.location.origin ? win.location.origin : null
      } catch (_error) {
        return null
      }
    }

    // --- clipboard: the top half performs the write, this half reports the answer ----------
    var pending = {}
    var sequence = 0
    var settle = function (id, result) {
      var entry = pending[id]
      if (!entry) return false
      delete pending[id]
      if (entry.timer !== null && typeof win.clearTimeout === 'function') win.clearTimeout(entry.timer)
      if (result && result.ok === true) entry.resolve(true)
      else entry.reject(new Error((result && typeof result.reason === 'string' && result.reason) || 'bridge'))
      return true
    }
    // The desktop carrier cannot reach into the guest, so it answers through this slot.
    win.__drgCapabilityReply = function (payload) {
      if (!payload || typeof payload !== 'object') return false
      return settle(String(payload.id === undefined || payload.id === null ? '' : payload.id), payload)
    }
    var ask = function (intent, timeoutMs) {
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
        if (answer && typeof answer.then === 'function') {
          answer.then(
            function (result) {
              settle(id, result)
            },
            function () {
              settle(id, { ok: false })
            },
          )
        }
      })
    }
    // The frame is the document the user just clicked in, so the legacy path can still land
    // the text when the top half reports a refusal.
    var legacyCopy = function (text) {
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
      var bridgeWriteText = function (text) {
        var value = text === undefined || text === null ? '' : String(text)
        return ask({ action: 'clipboard-write', text: value }, 4000).then(
          function () {
            return undefined
          },
          function () {
            if (legacyCopy(value)) return undefined
            try {
              emit({ action: 'notify', tone: 'error', code: 'clipboard-failed' })
            } catch (_error) {
              /* the local half may be gone */
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
          /* a browser that freezes the Clipboard object keeps its own writeText */
        }
      }
    }

    // --- links: capture a real external click before the page's own handler swallows it ------
    var onLinkClick = function (event) {
      if (!event || event.defaultPrevented === true) return
      // A modified or non-primary click is the user asking for the browser's own behaviour
      // (new background tab, new window, middle-click paste): leave it to the page and the
      // browser, exactly like the chat view's own `openExternalLink` handler does. Otherwise
      // the bridge would silently take those gestures over.
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
      // A same-origin link is part of the framed application (the DSH router): leave it alone,
      // a new tab would open the remote UI without its host row.
      var origin = originOf()
      if (origin !== null && resolved.origin === origin) return
      event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      try {
        emit({ action: 'open-external', url: url })
      } catch (_error) {
        /* the local half may be gone */
      }
    }
    doc.addEventListener('click', onLinkClick, true)

    // --- window.open: a resolved web URL belongs to the top-level document --------------------
    var nativeOpen = typeof win.open === 'function' ? win.open : null
    try {
      win.open = function (url, name, features) {
        var raw = typeof url === 'string' ? url : url === undefined || url === null ? '' : String(url)
        var target = externalUrl(raw)
        if (target === null) {
          // `about:blank` is the account login's popup skeleton: it has no URL to hand over,
          // so it keeps the native call (the frame now declares `allow-popups` for it).
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
          /* the local half may be gone */
        }
        return null
      }
    } catch (_error) {
      /* a browser that freezes `window.open` keeps the native one */
    }
    // Only claim the bridge once every shim above is in place: a half-installed page must be
    // retried by the next load stop instead of reporting `already` forever.
    win.__drgCapabilityBridge = true
    return 'installed'
  } catch (_error) {
    return 'error'
  }
}

const CAPABILITY_BRIDGE_SCRIPT = '(' + mountCapabilityBridge.toString() + ')(window)'
