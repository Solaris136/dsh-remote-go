// client/src/react.ts - React element helpers (h, box, footerRow, the four hooks); first module - every UI module below uses it.
// The loader shell around them lives in `client/template.js`; `scripts/build-client.mjs` composes the two.
// Keep this a pure move of the published body: no behaviour, class name, ARIA attribute, string, storage key or event may change here.

const h = React.createElement
/** Element whose only prop is its class: h(tag, { className }, ...children) with the class forwarded as given. */
// Some call sites pass a props object with the old `{ className: … }` nesting, so the type follows the runtime.
const box = (tag: string, className: string | Record<string, unknown>, ...children: ReactNode[]): ReactElement =>
  h(tag, { className }, ...children)
/** A dialog's action strip: one right-aligned row of buttons. */
const footerRow = (...actions: ReactNode[]): ReactElement => h('div', { className: 'drg-row drg-row-end' }, ...actions)
const { useCallback, useEffect, useRef, useState } = React
