// Names that exist inside the factory written by `client/template.js` — never imported from a
// module. The modules under `client/src/` are the implementation (one script scope, concatenated in
// the order `scripts/build-client.mjs` lists them); the loader shell around them is what supplies
// these bindings, so a type check of the implementation alone needs them declared here.
//
// The same file also completes `Window` for the page-side hooks this plugin uses. Every one of them
// is a property some other document (the shell's preload, the DSH web boot script, or a guest copy
// of the switcher row) creates, so `lib.dom` cannot know it: the augmentation is the declaration,
// not a cast. A member is only declared here when the plugin reads it; nothing is invented.
import type * as ReactNamespace from 'react'

declare global {
  /**
   * The DSH browser loader. The one call lives in `client/template.js` (the frozen contract text);
   * the declaration exists so the type checker knows the explicit global the shell relies on.
   */
  interface Window {
    __ModuleLoader__: {
      load(spec: { id: string; factory(require: (id: string) => unknown): unknown }): void
    }

    /** The shell's boot payload; `readBootVersion` reports `release.version` back to the Host. */
    __DSH_BOOT__: BootPayload

    /** The shell's own directory picker (desktop preload); absent in the browser build. */
    __DSH_DIRECTORY_PICKER__: DirectoryPicker

    /** The desktop shell's guest-surface bridge; absent in the browser build. */
    dshDesktop: DshDesktopBridge

    /**
     * The switcher row a page currently carries. This page creates its own (see `mountHostRow`);
     * a guest carries the copy injected by `carrier-install.ts`.
     */
    __drgHostRow: HostRowHandle

    /**
     * The intent sink a page's row calls; set on this page and inside a framed guest page.
     */
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

    /**
     * A browser global the injected caption script reads off the guest's own `window`
     * (`win.MutationObserver`), which `lib.dom` declares only as a bare global.
     */
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

  /**
   * `window.dshDesktop`: the desktop shell's guest bridge. The version is checked against
   * `DESKTOP_BRIDGE_VERSION` before anything else is touched, so a shell that speaks another
   * protocol is ignored rather than half-used (see `desktopBrowserBridge`).
   */
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

  /**
   * The row handle a page carries at `window.__drgHostRow`. `update` reports the install status
   * (`installed`, `absent`, `collapsed`, …) that `switcher.installed` records.
   */
  interface HostRowHandle {
    update(payload: unknown): string
    destroy(): void
  }

  /**
   * React's own change-event type, reachable without an `import`: the modules are one script
   * scope and must not import anything, and a React prop such as `onChange` is typed with it.
   */
  type ReactChangeEvent<T extends Element> = ReactNamespace.ChangeEvent<T>

  /**
   * React's pointer-event type, for the download stack's drag: its `currentTarget` carries the
   * pointer-capture calls a plain DOM `PointerEvent` types on the wrong node.
   */
  type ReactPointerEvent<T extends Element> = ReactNamespace.PointerEvent<T>

  /** A keyboard event handler's parameter, for the same reason (`TextInput`'s Enter gate). */
  type ReactKeyboardEvent<T extends Element> = ReactNamespace.KeyboardEvent<T>

  /** A click handler's parameter, for a card whose own controls must not re-trigger it. */
  type ReactMouseEvent<T extends Element> = ReactNamespace.MouseEvent<T>

  /**
   * React's node and element types, for the same reason: a component's prop interface lives in
   * `contract.d.ts`, which is also a script (no `import`) and so cannot name `React.ReactNode`.
   */
  /** Element.moveBefore (the state-preserving move); not in lib.dom yet, and the caller checks. */
  interface Element {
    moveBefore?(node: Node, child: Node | null): void
  }

  type ReactNode = ReactNamespace.ReactNode
  type ReactElement = ReactNamespace.ReactElement

  /**
   * The factory parameter (`factory(require)`). Only the template calls it, and it may only ever be
   * asked for `react`; the build asserts that (test/unit/guards.test.js `client-compat` too).
   */
  const require: (id: string) => unknown

  /**
   * `const React = require('react')` in the template. React is injected by the loader, never
   * bundled, so the implementation must not `import` it.
   */
  const React: typeof ReactNamespace
}

export {}
