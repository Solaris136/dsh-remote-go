// Names that exist inside the factory written by `client/template.js` — never imported from a
// module. `client/src/main.ts` is the implementation; the loader shell around it is what supplies
// these three bindings, so a type check of the implementation alone needs them declared here.
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
  }

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

  /**
   * The stylesheet: `const CSS = \`…\`` in `client/src/main.ts`. Declared here because the value is
   * contract data (the `<style>` body) rather than code, and P3c will hand it to the template.
   * Until then `main.ts` declares the same name (the P3a move is verbatim), so `tsc` reports one
   * expected redeclaration: the diagnostic marks the hand-off, not a behaviour problem.
   */
  const CSS: string

  /**
   * The plugin face. `client/src/main.ts` assembles it as its last statement; the template returns
   * it to the loader exactly as written. Same expected redeclaration as `CSS` until P3b makes the
   * template own this binding.
   */
  const __drgExport: unknown
}

export {}
