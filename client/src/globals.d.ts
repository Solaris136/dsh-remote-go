// Names that exist inside the factory from `client/template.js`, never imported: client/src is one script scope.
// The loader shell supplies these bindings and scripts/build-client.mjs fixes the order.
// It also completes `Window` for hooks other documents create (preload, DSH web boot, a guest row copy),
// which `lib.dom` cannot know: the augmentation is the declaration, not a cast, and only read members are listed.
import type * as ReactNamespace from 'react'

declare global {
  interface Window {
    /** The DSH browser loader; the one call lives in `client/template.js`. */
    __ModuleLoader__: {
      load(spec: { id: string; factory(require: (id: string) => unknown): unknown }): void
    }
    /** The shell's boot payload; `readBootVersion` reports `release.version` back to the Host. */
    __DSH_BOOT__: BootPayload
    /** The shell's own directory picker (desktop preload); absent in the browser build. */
    __DSH_DIRECTORY_PICKER__: DirectoryPicker
    /** The desktop shell's guest-surface bridge; absent in the browser build. */
    dshDesktop: DshDesktopBridge
    /** The switcher row a page carries: this page creates its own, a guest the injected copy. */
    __drgHostRow: HostRowHandle
    /** The intent sink a page's row calls; set on this page and inside a framed guest page. */
    __drgBridgeSink: (intent: unknown) => IntentReceipt | boolean | undefined
    /** Guest-only: the queue the injected row, tools and capability bridge push intents into. */
    __drgBridgeQueue?: unknown[]
    /** Guest-only: `mountSidebarMirror`'s own idempotence flag. */
    __drgSidebarMirror?: boolean
    /** Guest-only: `mountGuestTools`'s installed flag. */
    __drgGuestTools?: boolean
    /** Guest-only: `mountCapabilityBridge`'s installed flag. */
    __drgCapabilityBridge?: boolean
    /** Guest-only: the clipboard receipt slot the desktop carrier answers through. */
    __drgCapabilityReply?: (payload: unknown) => boolean
    /** The guest page's own constructors, read off its window (never the host's). */
    Promise: PromiseConstructor
    URL: typeof URL
    /** Guest-only: the row's single injected stylesheet (reused across installs). */
    __drgHostRowStyle?: HTMLElement | null
    /** Guest-only: the host id whose `drg:<id>:` key space the storage partition owns. */
    __drgStoragePartition?: string
    /** A global the injected caption script reads off the guest's own `window`. */
    MutationObserver: typeof MutationObserver
  }

  /** `window.__DSH_BOOT__`: only the release identity is read here (see `readBootVersion`). */
  interface BootPayload {
    release?: { version?: string }
  }

  /** `window.__DSH_DIRECTORY_PICKER__`: resolves the picked folder, or null when cancelled. */
  interface DirectoryPicker {
    pick?: () => Promise<unknown>
  }

  /** `window.dshDesktop`: the version is checked against `DESKTOP_BRIDGE_VERSION` first, so a mismatch is ignored. */
  interface DshDesktopBridge {
    protocolVersion?: number
    browser?: DshDesktopBrowser
  }

  /** The lease handed out per remote window; both fields are checked before they are used. */
  interface DesktopReservation {
    lease?: string
    partition?: string
  }

  /** The guest surface itself: one lease per warm host, released on teardown. */
  interface DshDesktopBrowser {
    acquire(owner: string): Promise<DesktopReservation>
    release(lease: string): Promise<void>
  }

  /** The row handle a page carries at `window.__drgHostRow`; `update` reports the install status. */
  interface HostRowHandle {
    update(payload: unknown): string
    destroy(): void
  }

  /** React's event types, reachable without an `import`: the modules share one script scope and import nothing. */
  type ReactChangeEvent<T extends Element> = ReactNamespace.ChangeEvent<T>
  type ReactPointerEvent<T extends Element> = ReactNamespace.PointerEvent<T>
  type ReactKeyboardEvent<T extends Element> = ReactNamespace.KeyboardEvent<T>
  type ReactMouseEvent<T extends Element> = ReactNamespace.MouseEvent<T>
  /** React's node and element types, for the same reason: a prop interface cannot name `React.ReactNode`. */
  type ReactNode = ReactNamespace.ReactNode
  type ReactElement = ReactNamespace.ReactElement
  /** Element.moveBefore (the state-preserving move); not in lib.dom yet, and the caller checks. */
  interface Element {
    moveBefore?(node: Node, child: Node | null): void
  }

  /** The factory parameter (`factory(require)`); it may only ever be asked for `react` (guards.test). */
  const require: (id: string) => unknown
  /** `const React = require('react')` in the template; React is injected by the loader, never bundled. */
  const React: typeof ReactNamespace
}

export {}
