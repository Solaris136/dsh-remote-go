// client/src/react.ts - React element helpers (h, box, footerRow, the four hooks) and the original file preamble kept verbatim; first module - every UI module below uses it.
// The client half's implementation: the whole body of the published `client.js`, moved here
// verbatim (P3a) so that a build step can own the file. The loader shell around it lives in
// `client/template.js`; `scripts/build-client.mjs` composes the two and runs prettier.
//
// The code is deliberately still untyped/loosely typed: P3b splits it into modules and P3c
// tightens the types. Keep it a pure move - no behaviour, class name, ARIA attribute, string,
// storage key or event may change here.

const h = React.createElement
/** Element whose only prop is its class: h(tag, { className }, ...children) without the noise. */
const box = (tag, className, ...children) => h(tag, { className }, ...children)
/** A dialog's action strip: one right-aligned row of buttons. */
const footerRow = (...actions) => h('div', { className: 'drg-row drg-row-end' }, ...actions)
const { useCallback, useEffect, useRef, useState } = React
