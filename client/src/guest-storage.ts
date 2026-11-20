// client/src/guest-storage.ts - mountGuestStorage: the guest frame's private localStorage partition (9b 4/11); after guest-tools.ts, before carrier-pool.ts.
/** A same-origin frame shares this origin's `localStorage`, so this page and the remote UI overwrite each other. */
// Give it a private key space: a Storage-shaped view whose keys carry a `drg:<hostId>:` prefix, so writes stay apart.
// `sessionStorage`, cookies and IndexedDB are untouched; foreign `storage` events are dropped after this script.
function mountGuestStorage(win: Window, hostId: unknown): string {
  try {
    if (typeof hostId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) return 'bad-id'
    if (!win || typeof win !== 'object') return 'no-window'
    if (win.__drgStoragePartition === hostId) return 'already'
    var raw: Storage | null = null
    try {
      raw = win.localStorage
    } catch (_error) {
      return 'no-storage'
    }
    if (!raw || typeof raw.getItem !== 'function' || typeof raw.setItem !== 'function') return 'no-storage'
    var prefix = 'drg:' + hostId + ':'
    var prefixed = function (key: unknown) {
      return prefix + String(key)
    }
    var ownKeys = function (): string[] {
      var keys: string[] = []
      try {
        for (var index = 0; index < raw.length; index += 1) {
          var key = raw.key(index)
          if (typeof key === 'string' && key.indexOf(prefix) === 0) keys.push(key.slice(prefix.length))
        }
      } catch (_error) {
        return []
      }
      return keys
    }
    var view = {
      get length() {
        return ownKeys().length
      },
      key: function (index: unknown) {
        var keys = ownKeys()
        var at = Number(index)
        return at >= 0 && at < keys.length && Math.floor(at) === at ? keys[at] : null
      },
      getItem: function (key: string) {
        return raw.getItem(prefixed(key))
      },
      setItem: function (key: string, value: unknown) {
        raw.setItem(prefixed(key), String(value))
      },
      removeItem: function (key: string) {
        raw.removeItem(prefixed(key))
      },
      clear: function () {
        var keys = ownKeys()
        for (var index = 0; index < keys.length; index += 1) raw.removeItem(prefixed(keys[index]))
      },
    }
    try {
      Object.defineProperty(win, 'localStorage', {
        // Non-configurable: a page must not `delete window.localStorage` and fall back to the shared origin store.
        configurable: false,
        enumerable: true,
        get: function () {
          return view
        },
      })
    } catch (_error) {
      return 'blocked'
    }
    win.__drgStoragePartition = hostId
    // Another document on this origin writing a preference raises `storage` here, which the remote UI must not follow.
    if (typeof win.addEventListener === 'function') {
      try {
        win.addEventListener(
          'storage',
          function (event: StorageEvent) {
            var key = event && typeof event.key === 'string' ? event.key : null
            if (key === null || key.indexOf(prefix) === 0) return
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          },
          true,
        )
      } catch (_error) {
        // swallow-ok: a window without event listeners still gets the partitioned store
      }
    }
    return 'installed'
  } catch (_error) {
    return 'error'
  }
}
