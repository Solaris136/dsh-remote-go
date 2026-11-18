// client/src/guest-storage.ts - mountGuestStorage: the guest frame's private localStorage partition (9b 4/11); after guest-tools.ts, before carrier-pool.ts.
/**
 * A same-origin frame shares this origin's `localStorage`, so the remote UI and this page would
 * keep their preferences in one place and overwrite each other. Give the frame a private key
 * space: `localStorage` becomes a Storage-shaped view whose keys carry a `drg:<hostId>:`
 * prefix. Writes from the frame can no longer touch a local preference, and its own values
 * survive a local edit because they live under different keys.
 *
 * Boundaries (documented in docs/design.md): values the page read before this injection came
 * from the shared store; `sessionStorage`, cookies and IndexedDB are untouched; a `storage`
 * event from another same-origin document is dropped while it is not this host's key, but only
 * for listeners registered after this script — a listener the page installed at boot already
 * ran.
 */
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
        // Non-configurable: the page must not be able to `delete window.localStorage` and
        // fall back to the shared origin store (documented data-hygiene limit, audit S3).
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
    // Another document on this origin writing a preference raises `storage` here; the remote
    // UI must not follow the local page. Only keys outside this host's namespace are dropped.
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
