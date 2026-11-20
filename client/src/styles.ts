// client/src/styles.ts - PanelStyleSheet(); the stylesheet itself lives in client/template.js (factory scope, so lib.dom's global `CSS` namespace is not redeclared); after plugin-overlay.ts, before plugin.ts.
//#region 16. styles

function PanelStyleSheet() {
  // A global `declare const CSS` cannot merge with lib.dom's namespace, which TypeScript prefers.
  // `String()` is a runtime no-op on that value and keeps this file type-checkable without a suppression directive.
  return h('style', { 'data-dsh-remote-go': 'styles', dangerouslySetInnerHTML: { __html: String(CSS) } })
}
