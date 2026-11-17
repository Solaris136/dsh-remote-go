// client/src/styles.ts - const CSS (the whole panel stylesheet) and StyleSheet(); after plugin-overlay.ts, before plugin.ts.
//#region 16. styles

const CSS = `
    /*
     * No local token layer: every colour, surface, radius and shadow is the host's own --dsw-*
     * alias, so a theme change restyles the whole surface on the next paint.
     */
    .drg-root {
      color-scheme: inherit; display: flex; flex-direction: column; height: 100%; min-height: 0;
      color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-family: var(--dsw-font-family);
      font-size: 13px; line-height: 1.5; box-sizing: border-box; -webkit-font-smoothing: antialiased;
    }
    .drg-root *, .drg-root *::before, .drg-root *::after { box-sizing: border-box; }
    .drg-root ::selection { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
    .drg-root h1, .drg-root h2, .drg-root h3, .drg-root p, .drg-root ul, .drg-root ol, .drg-root dl, .drg-root dd, .drg-root dt { margin: 0; }
    .drg-root ul, .drg-root ol { padding: 0; list-style: none; }
    .drg-root code { font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 12px; }
    .drg-root button { font: inherit; color: inherit; }
    /* The ring colour is read inside the rule, not hoisted onto .drg-root: the host marks
       pointer modality by setting --dsw-focus-ring-color on the focused element itself, and a
       value computed on an ancestor would keep painting a ring for mouse users. */
    .drg-root :focus-visible {
      outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
      outline-offset: 1px;
    }
    .drg-root ::-webkit-scrollbar { width: 10px; height: 10px; }
    .drg-root ::-webkit-scrollbar-thumb {
      border: 2px solid transparent; background-clip: content-box; background-color: var(--dsw-alias-scrollbar-bg-l2);
      border-radius: 999px;
    }
    .drg-root ::-webkit-scrollbar-thumb:hover { background-color: var(--dsw-alias-scrollbar-hover-l2); }
    .drg-root ::-webkit-scrollbar-corner { background: transparent; }
    /* A seat in the shell overlay layer: it only carries the dialog (which is fixed); it
       must not paint or take size, or it would cover the app behind it. */
    .drg-root.drg-overlay { display: block; height: auto; background: transparent; }
    .drg-break { word-break: break-all; }

    /* ---- page --------------------------------------------------------------- */
    .drg-page {
      display: flex; flex-direction: column; gap: 20px; flex: 1; min-height: 0; overflow: auto; padding: 22px 24px 24px;
    }
    .drg-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .drg-page-heading { min-width: 0; }
    .drg-page-title { font-size: 20px; font-weight: 500; line-height: 28px; letter-spacing: -0.01em; }
    .drg-page-subtitle { margin-top: 2px; max-width: 68ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
    .drg-page-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    /* ---- layout helpers ----------------------------------------------------- */
    .drg-row { display: flex; align-items: center; gap: 8px; }
    .drg-row-wrap { flex-wrap: wrap; }
    .drg-row-end { justify-content: flex-end; }
    .drg-paragraph, .drg-fingerprint-body, .drg-error-detail { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
    .drg-section-label { margin-bottom: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }

    /* ---- buttons ------------------------------------------------------------ */
    .drg-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;
      border: 0.5px solid transparent; border-radius: var(--dsw-radius-md); background: transparent; color: inherit;
      font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .drg-btn:disabled { cursor: default; opacity: 0.5; }
    .drg-btn[data-busy="true"] { cursor: progress; }
    .drg-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; }
    /* Two classes plus the label span: the app ships its own element-level button colour rule, so a
       single-class declaration loses the cascade and the label renders in the same colour as the
       fill (invisible text on the primary button). */
    .drg-btn.drg-btn-primary,
    .drg-btn.drg-btn-primary .drg-btn-label { color: var(--dsw-alias-label-primary-foreground); }
    .drg-btn-primary:hover:not(:disabled), .drg-btn-primary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
    .drg-btn-secondary { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
    .drg-btn-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l4); }
    .drg-btn-ghost { color: var(--dsw-alias-label-secondary); }
    .drg-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .drg-btn-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l3)); color: var(--dsw-alias-state-error-primary); }
    .drg-btn-danger:hover:not(:disabled) {
      background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent));
      border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, transparent);
    }
    .drg-btn-label { display: inline-flex; align-items: center; gap: 6px; }
    .drg-iconbtn {
      display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none;
      padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent;
      color: var(--dsw-alias-label-secondary); cursor: pointer;
    }
    .drg-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .drg-iconbtn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
    .drg-iconbtn:disabled { opacity: 0.5; cursor: default; }
    .drg-downloads {
      position: fixed; right: 16px; bottom: 16px; z-index: 56; display: flex; flex-direction: column;
      gap: 8px; width: 320px; max-width: calc(100vw - 32px); pointer-events: none;
      will-change: transform;
    }
    .drg-download {
      pointer-events: auto; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
      box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary);
    }
    .drg-download-error { border-color: var(--dsw-alias-state-error-primary); }
    .drg-download-error .drg-download-fill { background: var(--dsw-alias-state-error-primary); }
    .drg-download-head {
      display: flex; align-items: center; gap: 6px; min-width: 0;
      cursor: grab; user-select: none; touch-action: none;
    }
    .drg-download-head:active { cursor: grabbing; }
    .drg-download-grip { display: inline-flex; flex: none; color: var(--dsw-alias-label-tertiary); }
    .drg-download-title {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; line-height: 1.45;
    }
    .drg-download-action {
      flex: none; height: 22px; padding: 0 7px; border: 0.5px solid var(--dsw-alias-border-l2);
      border-radius: var(--dsw-radius-sm); background: transparent;
      color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer;
    }
    .drg-download-action:hover {
      background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
    }
    .drg-download-track {
      height: 4px; margin-top: 8px; overflow: hidden; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-download-fill {
      display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary);
      transition: width 160ms ease;
    }
    .drg-download-track[data-indeterminate] .drg-download-fill {
      animation: drg-download-pulse 1.2s ease-in-out infinite;
    }
    @keyframes drg-download-pulse {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(320%); }
    }
    .drg-download-meta {
      display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; font-size: 11px;
      color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
    }
    .drg-download-detail {
      margin: 6px 0 0; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-state-error-primary);
    }
    .drg-linkbtn {
      padding: 0 2px; border: none; border-radius: var(--dsw-radius-xs); background: none; color: var(--dsw-alias-link);
      font-size: 12.5px; cursor: pointer;
    }
    .drg-linkbtn:hover { text-decoration: underline; text-underline-offset: 2px; }
    /* Available to assistive technology only: a live region and its visible twin must not
       announce the same update twice. */
    .drg-sr-only {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
    }

    /* ---- status ------------------------------------------------------------- */
    .drg-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; }
    .drg-dot[data-tone="success"] { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent); }
    .drg-badge {
      display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px;
      border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: transparent;
      color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-weight: 500; line-height: 18px;
      white-space: nowrap;
    }
    .drg-badge[data-tone="success"] { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); border-color: transparent; }
    .drg-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
    .drg-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); border-color: transparent; }
    .drg-badge[data-tone="info"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); border-color: transparent; }
    .drg-badge[data-tone="limited"] { color: var(--dsw-static-violet-400); background: color-mix(in srgb, var(--dsw-static-violet-400) 12%, transparent); border-color: transparent; }

    /* ---- loading / empty ---------------------------------------------------- */
    .drg-spinner {
      display: inline-block; flex: none; border-radius: 50%;
      border: 2px solid color-mix(in srgb, currentColor 22%, transparent); border-top-color: currentColor;
      animation: drg-spin 0.8s linear infinite;
    }
    @keyframes drg-spin { to { transform: rotate(360deg); } }
    .drg-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 16px; color: var(--dsw-alias-label-secondary); }
    .drg-empty {
      display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 56px 24px; text-align: center;
      border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
    }
    .drg-empty-icon {
      display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 2px; border-radius: 50%;
      border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-tertiary);
    }
    .drg-empty-title { font-size: 16px; font-weight: 500; }
    .drg-empty-body { max-width: 46ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }

    /* ---- host list ---------------------------------------------------------- */
    .drg-host-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .drg-summary { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    .drg-host-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
    .drg-host-card {
      display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 16px;
      border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg);
      background: var(--dsw-alias-bg-layer-1); transition: border-color 160ms ease, background-color 160ms ease;
    }
    .drg-host-card:hover { border-color: var(--dsw-alias-border-l4); }
    .drg-host-card[data-status="connected"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, var(--dsw-alias-border-l1)); }
    .drg-card-strip {
      display: flex; align-items: center; gap: 6px; margin: -16px -16px 0; padding: 6px 14px;
      border-radius: var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0; background: var(--dsw-alias-state-warn-tertiary);
      color: var(--dsw-alias-state-warn-label); font-size: 12px;
    }
    .drg-host-card[data-status="error"] .drg-card-strip,
    .drg-host-card[data-status="limited"] .drg-card-strip {
      background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
      color: var(--dsw-alias-state-error-primary);
    }
    .drg-card-strip-text, .drg-conflict-processes span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .drg-card-strip .drg-linkbtn { margin-left: auto; flex: none; color: inherit; }
    .drg-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .drg-card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 500; line-height: 22px; }
    .drg-card-address { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 12px; }
    .drg-card-progress { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
    .drg-card-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; }
    .drg-card-meta > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .drg-card-meta dt { color: var(--dsw-alias-label-secondary); font-size: 11px; }
    .drg-card-meta dd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }
    .drg-card-actions {
      display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 2px; padding-top: 12px;
      border-top: 0.5px solid var(--dsw-alias-border-l1);
    }
    .drg-card-actions-end { display: flex; align-items: center; gap: 2px; margin-left: auto; }

    /* ---- notices ------------------------------------------------------------ */
    .drg-notice {
      display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
      border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-notice-icon { flex: none; margin-top: 1px; color: var(--dsw-alias-label-tertiary); }
    .drg-notice-body { flex: 1; min-width: 0; }
    .drg-notice-title { font-weight: 500; }
    .drg-notice-text { color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 19px; }
    .drg-notice[data-tone="warn"] { background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
    .drg-notice[data-tone="warn"] .drg-notice-icon { color: var(--dsw-alias-state-warn-primary); }
    .drg-notice[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); border-color: transparent; }
    .drg-notice[data-tone="error"] .drg-notice-icon { color: var(--dsw-alias-state-error-primary); }
    .drg-notice[data-tone="success"] { background: var(--dsw-alias-state-success-tertiary); border-color: transparent; }
    .drg-notice[data-tone="success"] .drg-notice-icon { color: var(--dsw-alias-state-success-primary); }

    /* ---- connect state ------------------------------------------------------ */
    .drg-progress { display: flex; flex-direction: column; gap: 14px; width: min(600px, 100%); margin: auto; padding: 12px 4px 20px; }
    .drg-progress-head { display: flex; align-items: center; gap: 10px; color: var(--dsw-alias-state-business-primary); }
    .drg-progress-title { color: var(--dsw-alias-label-primary); font-size: 16px; font-weight: 500; }
    .drg-progress-line { color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
    .drg-phases { display: flex; gap: 6px; flex-wrap: wrap; }
    .drg-phase {
      display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
      border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-tertiary);
      font-size: 11.5px;
    }
    .drg-phase[data-state="current"] {
      color: var(--dsw-alias-label-primary);
      border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, transparent);
      background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
    }
    .drg-phase[data-state="done"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent); }
    .drg-phase-mark { display: inline-flex; width: 12px; height: 12px; align-items: center; justify-content: center; }

    .drg-fingerprint {
      display: flex; flex-direction: column; gap: 12px; width: min(640px, 100%); margin: auto; padding: 20px;
      border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, var(--dsw-alias-border-l2));
      border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-state-warn-tertiary);
    }
    .drg-fingerprint-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--dsw-alias-state-warn-label); }
    .drg-fingerprint-icon[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
    .drg-fingerprint-title, .drg-error-title { font-size: 17px; font-weight: 500; letter-spacing: -0.01em; }

    .drg-kv { display: flex; flex-direction: column; gap: 0; padding: 4px 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
    .drg-kv > div { display: flex; align-items: baseline; gap: 14px; padding: 8px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-kv > div:last-child, .drg-keyfile-row:last-child { border-bottom: 0; }
    .drg-kv dt { flex: none; min-width: 108px; color: var(--dsw-alias-label-caption); font-size: 12px; }
    .drg-kv dd { min-width: 0; margin: 0; color: var(--dsw-alias-label-primary); word-break: break-word; }

    .drg-error-card {
      display: flex; flex-direction: column; align-items: flex-start; gap: 12px; width: min(640px, 100%); margin: auto;
      padding: 20px;
      border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2));
      border-radius: var(--dsw-radius-lg);
      background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
    }
    .drg-error-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
    .drg-error-steps { width: 100%; }
    .drg-error-steps ul { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
    .drg-error-steps li::before { content: "· "; color: var(--dsw-alias-label-caption); }

    /* ---- dialogs ------------------------------------------------------------ */
    .drg-modal-layer { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .drg-modal-backdrop, .drg-drawer-backdrop {
      position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur);
      animation: drg-fade-in 140ms ease-out;
    }
    .drg-modal {
      position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(600px, 100%);
      max-height: min(86vh, 900px); padding-bottom: 24px; border: 0; border-radius: var(--dsw-radius-panel);
      background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      box-shadow: var(--dsw-elevation-prominent); overflow: hidden;
      animation: drg-dialog-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .drg-modal-wide { width: min(880px, 100%); }
    .drg-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 0 24px; }
    .drg-modal-titles { min-width: 0; }
    .drg-modal-title, .drg-drawer-title { font-size: 16px; font-weight: 500; line-height: 24px; }
    .drg-modal-subtitle { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 18px; }
    .drg-modal-body { padding: 0 24px; overflow: auto; min-height: 0; }
    .drg-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 24px; }
    /* Management window: the host list draws its own page header, so the shell header is
       reduced to the floating close button instead of leaving an empty strip on top. */
    .drg-modal[data-bare="true"] { gap: 0; padding-bottom: 0; }
    .drg-modal[data-bare="true"] .drg-modal-head { position: absolute; top: 14px; right: 14px; z-index: 3; width: auto; padding: 0; }
    .drg-modal[data-bare="true"] .drg-modal-body { display: flex; flex-direction: column; min-height: 0; padding: 0; }
    .drg-manage-window { display: flex; flex-direction: column; min-height: 0; }
    .drg-manage-window .drg-modal { height: min(86vh, 900px); }
    /* The window is a fixed height, so its body has to take what the chrome leaves: the host
       list scrolls in it, and the connect window's log grows to the bottom edge. */
    .drg-manage-window .drg-modal-body { flex: 1; }
    .drg-manage-window .drg-page { padding-right: 60px; }
    .drg-manage-live { padding: 18px 60px 14px 24px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
    .drg-manage-live .drg-progress, .drg-manage-live .drg-fingerprint { margin: 0; padding: 0; width: 100%; }
    .drg-manage-live .drg-fingerprint { border-color: transparent; background: transparent; padding: 0; }
    /* The connect log takes the rest of the window: a connection prints its progress in the
       block above and every line the Host wrote underneath, exactly as it was written. */
    .drg-manage-window .drg-connect-log { flex: 1; min-height: 0; }

    /* ---- connect log -------------------------------------------------------- */
    .drg-connect-log { display: flex; flex-direction: column; gap: 6px; min-height: 0; padding: 14px 24px 18px; }
    .drg-connect-log-head { display: flex; align-items: baseline; gap: 8px; padding-right: 46px; }
    .drg-connect-log-title { color: var(--dsw-alias-label-secondary); font-size: 12.5px; font-weight: 500; }
    .drg-connect-log-hint { color: var(--dsw-alias-label-caption); font-size: 11.5px; }
    .drg-connect-log-count {
      margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; font-variant-numeric: tabular-nums;
    }
    .drg-connect-log-body {
      flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-markdown-code-font-family); font-size: 11.5px;
      line-height: 1.7; overflow-wrap: anywhere;
    }
    .drg-connect-log-body:focus-visible, .drg-keyfile-row:focus-visible { outline-offset: -2px; }
    .drg-connect-log-line { display: flex; align-items: baseline; gap: 10px; }
    .drg-connect-log-time { flex: none; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
    /* The phase a line was written in, so a long log can be read step by step. */
    .drg-connect-log-phase {
      flex: none; align-self: baseline; height: 18px; padding: 0 6px; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
      font-family: var(--dsw-font-family); font-size: 10.5px; line-height: 18px;
    }
    .drg-connect-log-text { min-width: 0; white-space: pre-wrap; }
    /* Each connection's first line: the boundary that says which attempt this log belongs to. */
    .drg-connect-log-line[data-boundary="true"] .drg-connect-log-text {
      color: var(--dsw-alias-label-secondary); font-weight: 500;
    }
    .drg-connect-log-line[data-level="debug"] .drg-connect-log-text { color: var(--dsw-alias-label-secondary); }
    .drg-connect-log-line[data-level="warn"] .drg-connect-log-text { color: var(--dsw-alias-state-warn-primary); }
    .drg-connect-log-line[data-level="error"] .drg-connect-log-text { color: var(--dsw-alias-state-error-primary); }
    .drg-connect-log-empty { color: var(--dsw-alias-label-caption); font-family: var(--dsw-font-family); }

    @keyframes drg-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes drg-dialog-in { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }

    /* ---- drawer ------------------------------------------------------------- */
    .drg-drawer-layer { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: flex-end; }
    .drg-drawer {
      position: relative; z-index: 1; display: flex; flex-direction: column; width: min(520px, 100%); height: 100%;
      background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      box-shadow: var(--dsw-elevation-panel); animation: drg-drawer-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes drg-drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
    .drg-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 22px 14px 14px 24px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-drawer-subtitle { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
    .drg-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px; }
    .drg-drawer-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-diag { display: flex; flex-direction: column; gap: 12px; }
    .drg-diag-head { display: flex; align-items: center; gap: 10px; }
    .drg-diag-time { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .drg-diag-list { display: flex; flex-direction: column; gap: 6px; }
    .drg-diag-check {
      display: flex; gap: 10px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
    }
    .drg-diag-status {
      flex: none; align-self: flex-start; min-width: 46px; height: 20px; padding: 0 6px; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); font-size: 10.5px;
      font-weight: 600; line-height: 20px; text-align: center; text-transform: uppercase;
    }
    .drg-diag-status[data-status="pass"] { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); }
    .drg-diag-status[data-status="fail"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
    .drg-diag-check-body { min-width: 0; }
    .drg-diag-check-title { font-size: 12.5px; font-weight: 500; }
    .drg-diag-check-detail { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }

    /* ---- forms -------------------------------------------------------------- */
    .drg-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; min-width: 0; }
    .drg-field-wide { grid-column: 1 / -1; }
    .drg-field-label { color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 500; }
    .drg-field-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
    .drg-field-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
    .drg-field-inline { display: flex; align-items: center; gap: 8px; }
    .drg-field-inline > :first-child { flex: 1; min-width: 0; }
    .drg-input, .drg-select {
      width: 100%; height: 36px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3);
      color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    /* The field keeps the app's focus ring for keyboard users; only a pointer focus drops the
       outline, because the border/shadow below already marks the field. Removed the old blanket
       outline:none, which also removed the ring for Tab users (audit S2-4). */
    .drg-input:focus:not(:focus-visible), .drg-select:focus:not(:focus-visible) { outline: none; }
    .drg-input:focus-visible, .drg-select:focus-visible { outline-offset: 1px; }
    .drg-input:hover:not(:disabled), .drg-select:hover:not(:disabled) { border-color: var(--dsw-alias-label-caption); }
    .drg-input:focus, .drg-select:focus {
      border-color: var(--dsw-alias-state-business-primary);
      box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
    }
    .drg-input:disabled, .drg-select:disabled { opacity: 0.6; cursor: not-allowed; background: var(--dsw-alias-bg-layer-2); }
    .drg-input::placeholder { color: var(--dsw-alias-label-tertiary); }
    /* The SSH-address input carries a <datalist> so aliases autocomplete while typing.
       Chromium then paints a native picker arrow that does not match the host's field
       chrome and duplicates the alias chips below, so the indicator is hidden. */
    .drg-input::-webkit-calendar-picker-indicator { display: none; opacity: 0; }
    .drg-check { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
    .drg-check input { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
    /* The remember choice and its consequence sit together, apart from the field above. */
    .drg-remember { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
    .drg-remember .drg-check { margin: 0; }
    .drg-remember .drg-field-hint { margin: 0 0 0 23px; }
    .drg-advanced { margin: 8px 0; border-top: 0.5px solid var(--dsw-alias-border-l1); padding-top: 8px; }
    .drg-advanced > summary { margin-bottom: 4px; font-size: 13px; cursor: pointer; }
    .drg-advanced-body { display: grid; gap: 4px; }
    .drg-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); align-items: start; gap: 0 16px; }
    .drg-form-grid-3 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .drg-divider { height: 0.5px; margin: 14px 0; background: var(--dsw-alias-border-l1); }

    /* ---- wizard ------------------------------------------------------------- */
    .drg-wizard-body { min-width: 0; }
    .drg-wizard-form { display: flex; flex-direction: column; gap: 10px; }
    .drg-alias-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    .drg-alias-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    .drg-alias-known { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11px; }
    .drg-chip {
      padding: 3px 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 999px; background: transparent;
      color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer;
    }
    .drg-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

    /* ---- key-file picker ---------------------------------------------------- */
    .drg-keyfile-path { margin: 2px 0 8px; color: var(--dsw-alias-label-caption); font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 11.5px; word-break: break-all; }
    .drg-keyfile-list { max-height: 320px; overflow-y: auto; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
    .drg-keyfile-row {
      display: flex; align-items: center; width: 100%; gap: 8px; padding: 8px 12px; border: 0;
      border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: transparent;
      color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
    }
    .drg-keyfile-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .drg-keyfile-row[data-kind='directory'] .drg-keyfile-name { font-weight: 500; }
    .drg-keyfile-row[data-kind='directory'] .drg-keyfile-name::before { content: "▸ "; color: var(--dsw-alias-label-caption); }
    .drg-keyfile-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ---- settings ----------------------------------------------------------- */
    .drg-settings { display: flex; flex-direction: column; gap: 20px; }
    .drg-settings-section {
      display: flex; flex-direction: column; gap: 8px; padding: 16px 18px;
      border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg);
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-settings-section .drg-field { margin-bottom: 8px; }
    .drg-settings-section .drg-form-grid { gap: 0 16px; }
    .drg-section-title { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
    .drg-settings-section > .drg-field-hint:first-of-type { margin-top: -4px; }

    /* ---- conflict ----------------------------------------------------------- */
    .drg-conflict-processes { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px; }
    .drg-conflict-processes li { display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
    .drg-conflict-processes code { padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }

    /* ---- toast -------------------------------------------------------------- */
    .drg-toast {
      position: fixed; left: 50%; bottom: 24px; z-index: 80; max-width: min(560px, calc(100vw - 32px));
      padding: 10px 16px; transform: translateX(-50%); border: none; border-left: 3px solid transparent;
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label);
      font-size: 12.5px; box-shadow: var(--dsw-elevation-prominent);
      animation: drg-toast-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    /* The tone is carried by the accent edge, not by filling the toast with a state colour:
       the host's toast pair stays legible while the edge names the outcome. */
    .drg-toast[data-tone="error"] { border-left-color: var(--dsw-alias-state-error-primary); }
    .drg-toast[data-tone="success"] { border-left-color: var(--dsw-alias-state-success-primary); }
    .drg-toast[data-tone="warn"] { border-left-color: var(--dsw-alias-state-warn-primary); }
    .drg-toast[data-tone="info"] { border-left-color: var(--dsw-alias-state-business-primary); }
    /* Toasts stack instead of replacing each other: a warning and a later error can both matter. */
    .drg-toasts {
      position: fixed; left: 50%; bottom: 24px; z-index: 80; display: flex; flex-direction: column;
      align-items: center; gap: 8px; max-width: min(560px, calc(100vw - 32px));
      transform: translateX(-50%); pointer-events: none;
    }
    .drg-toasts .drg-toast { position: static; transform: none; max-width: 100%; animation: drg-toast-rise 180ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes drg-toast-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes drg-toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translateX(-50%); } }

    /* ---- responsive / accessibility ---------------------------------------- */
    @media (prefers-reduced-motion: reduce) {
      .drg-root *, .drg-root *::before, .drg-root *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
      .drg-spinner { animation-duration: 2.4s; animation-iteration-count: infinite !important; }
    }
    @media (prefers-contrast: more) {
      .drg-host-card, .drg-settings-section, .drg-diag-check, .drg-kv { border-width: 1px; border-color: var(--dsw-alias-border-l4); }
    }
    @media (forced-colors: active) {
      .drg-dot { forced-color-adjust: none; }
      .drg-btn, .drg-input, .drg-select, .drg-host-card, .drg-modal, .drg-drawer, .drg-chip { border-color: ButtonText; }
      .drg-btn-primary { color: ButtonText; }
    }
    @media (max-width: 760px) {
      .drg-host-list { grid-template-columns: 1fr; }
      .drg-modal-layer { padding: 16px; }
      .drg-form-grid, .drg-form-grid-3 { grid-template-columns: 1fr; }
      .drg-card-meta { gap: 4px 12px; }
    }
    @media (max-width: 520px) {
      .drg-modal-layer { align-items: flex-end; padding: 0; }
      .drg-modal { width: 100%; max-height: 92vh; border-radius: var(--dsw-radius-panel) var(--dsw-radius-panel) 0 0; }
      .drg-drawer { width: 100%; }
      .drg-page { padding: 18px 16px 24px; }
      .drg-page-actions { width: 100%; justify-content: flex-end; }
    }
    /* The shell's overlay seat may have to float above a remote guest window. */
    [data-shell-overlay] { z-index: 2147483001; }
    /* While a guest fills the window it also paints the caption band, which the desktop
       window's own caption row sits on: the shell's caption menus (Windows) are the only
       local chrome left in that band, so they have to paint above the guest to stay usable.
       The class is only present while a guest owns the band. */
    html.drg-caption-live body > [data-windows-menu] { z-index: 2147483002; }
`

function StyleSheet() {
  return h('style', { 'data-dsh-remote-go': 'styles', dangerouslySetInnerHTML: { __html: CSS } })
}
