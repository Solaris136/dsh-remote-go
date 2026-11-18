// client/src/styles.ts - PanelStyleSheet(); the panel stylesheet itself lives in client/template.js (factory scope, so lib.dom's global `CSS` namespace is not redeclared); after plugin-overlay.ts, before plugin.ts.
//#region 16. styles

function PanelStyleSheet() {
  // lib.dom declares a global `CSS` namespace, which TypeScript prefers for this name even when a
  // global `declare const CSS: string` exists (a global declaration cannot merge with the namespace).
  // The template literal lives at the factory scope in `client/template.js`; `String()` is a runtime
  // no-op on that value and keeps this file type-checkable without a suppression directive.
  return h('style', { 'data-dsh-remote-go': 'styles', dangerouslySetInnerHTML: { __html: String(CSS) } })
}
