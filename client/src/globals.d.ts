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

    /** The intent sink a page's row calls; set on this page and inside a framed guest page. */
    __drgBridgeSink: (intent: unknown) => unknown
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
