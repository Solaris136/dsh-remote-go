// client/src/plugin.ts - apply(ctx), the components map, the __test face and the plugin face returned to the loader; last module.
//#region 17. plugin registration

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-go: dictionaries')
  const t = ctx.locale.bind(NS)

  // Backfill the Host's local-version probe when the page exposes it, and
  // start the authoritative `/state` read in parallel (docs/api.md).
  ctx.effect(() => {
    const version = readBootVersion()
    if (version) api.reportLocalVersion(version)
    api.getState().catch(() => {
      // The panel surfaces read failures in its own error view.
    })
    return () => {}
  }, 'dsh-remote-go: startup probe')

  const getLocaleId = () => {
    try {
      const locale = ctx.locale
      const snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
      if (snapshot && typeof snapshot.active === 'string') return snapshot.active
      const current = typeof locale.getLocale === 'function' ? locale.getLocale() : null
      if (current && typeof current.active === 'string') return current.active
    } catch (_error) {
      // fall back to the default dictionary
    }
    return 'zh'
  }

  const panelStore = createPanelRequestStore()
  // A carrier's failure layer hands the window back to the local page through this hook.
  requestLocalPage = () => panelStore.requestIntent({ kind: 'local' })
  const wizardStore = createWizardStore()
  const toolStore = createToolRequestStore()
  const openWizard = (draft) => {
    wizardStore.open(draft)
  }
  const sharedInject = () => ({
    panelStore,
    wizardStore,
    toolStore,
    openWizard,
    getLocaleId,
    pickDirectory: async () => {
      try {
        const workspaceUi = ctx.get('uiWorkspace')
        if (workspaceUi && typeof workspaceUi.pickDirectory === 'function') {
          const picked = await workspaceUi.pickDirectory()
          return typeof picked === 'string' && picked !== '' ? picked : null
        }
      } catch (_error) {
        // fall back to the desktop preload picker below
      }
      return undefined
    },
  })

  // Everything the plugin draws lives in the shell's overlay layer: the floating management window, the wizard and
  // the prompts. It sits above a remote window, so opening or closing them leaves the remote exactly as it was.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: PANEL_ID,
        order: 40,
        locale: NS,
        inject: sharedInject,
      },
      PluginOverlay,
    ),
  )

  // The window's one host control is the switcher row drawn into the sidebar of whichever page owns the
  // window: this one (local) or the remote guest's. It lists local plus every host, so picking one is all it
  // takes to move the window. It is the plugin's host entry: there is no settings page, no sidebar panel and
  // no main panel; management and the wizard are floating windows in the overlay layer.
  ctx.effect(() => {
    switcher.labelsOf = () => ({
      local: t('switcherLocal'),
      addHost: t('switcherAddHost'),
      manage: t('switcherManage'),
      exit: t('switcherExit'),
    })
    updateSwitcher()
    const timer = setInterval(() => updateSwitcher(), SWITCHER_TICK_MS)
    // The ticker is a safety net for a shell that re-rendered the sidebar away; it
    // must never keep a non-browser test process alive.
    unrefTimer(timer)
    return () => {
      if (typeof clearInterval === 'function') clearInterval(timer)
      switcher.dispatch = null
      switcher.labelsOf = null
      const win = localWindow()
      if (win !== null && win.__drgHostRow && typeof win.__drgHostRow.destroy === 'function') {
        win.__drgHostRow.destroy()
      }
      // Plugin disposal: every warm remote window and its lease goes with it.
      closeOverlay().catch(() => {})
      switcher.installed = false
    }
  }, 'dsh-remote-go: host switcher row')

  /** Hand the window back: the SSH link and the warm guest stay up, so coming back is instant. */
  function returnToLocal() {
    switcher.current = 'local'
    updateSwitcher({ current: 'local' })
    // Hidden, not closed: the remote window is already warm for the next visit.
    hideOverlays()
    panelStore.requestIntent({ kind: 'local' })
  }

  switcher.dispatch = (intent) => {
    if (intent.action === 'download-file') {
      // The guest's own file menu only produced a path; the local half owns the
      // SFTP read and the save, so no remote bytes ever cross the guest bridge.
      toolStore.requestDownload({
        hostId: intent.hostId,
        kind: intent.kind,
        path: intent.path,
        name: intent.name,
      })
      return
    }
    // --- capability bridge: this document is the one that may hold these capabilities -----
    if (intent.action === 'open-external') {
      const outcome = openExternalUrl(intent.url)
      // A URL the bridge refuses is the only failure it can prove: `noopener,noreferrer`
      // makes a successful open return null as well, so a popup-blocker refusal is invisible
      // here and must not be guessed at.
      if (outcome === 'blocked') {
        toolStore.requestNotice({ tone: 'error', text: t('externalLinkBlocked') })
      }
      return
    }
    if (intent.action === 'clipboard-write') {
      // The write itself happens in this document: the framed page cannot hold the clipboard
      // permission. The promise is the receipt the guest's `writeText` resolves on.
      const text = typeof intent.text === 'string' ? intent.text : ''
      return copyText(text).then(
        (ok) => ({ ok: ok === true }),
        () => ({ ok: false }),
      )
    }
    if (intent.action === 'notify') {
      // The bridge's only "say something" verb. Known codes map to this page's own strings;
      // free text stays the framed page's message, so it is tagged with its origin — a remote
      // notice must never read like local chrome (the trust model is in docs/design.md §4.8).
      const code = typeof intent.code === 'string' ? intent.code : ''
      let message = ''
      if (code === 'clipboard-failed') message = t('clipboardWriteFailed')
      else if (typeof intent.text === 'string' && intent.text !== '') {
        message = t('remoteNoticePrefix') + intent.text
      }
      if (message !== '') {
        toolStore.requestNotice({ tone: intent.tone === 'error' ? 'error' : 'info', text: message })
      }
      return
    }
    if (intent.action === 'add') {
      // The wizard floats over whatever is on screen — including a remote window.
      openWizard({ mode: 'add', host: null })
      return
    }
    if (intent.action === 'manage') {
      // Host management floats the same way: the window behind it does not change.
      panelStore.requestIntent({ kind: 'manage' })
      return
    }
    if (intent.action === 'disconnect' && typeof intent.hostId === 'string') {
      // The row's exit control: drop that host's link (and its warm window) without switching to it.
      panelStore.requestIntent({ kind: 'disconnect', hostId: intent.hostId })
      return
    }
    if (typeof intent.target !== 'string') return
    if (intent.target === 'local') {
      returnToLocal()
      return
    }
    // Say where the window is going at once; the overlay host does the rest.
    switcher.current = intent.target
    updateSwitcher({ current: intent.target })
    panelStore.requestIntent({ kind: 'open', hostId: intent.target })
    api.activate(intent.target).catch(() => {})
  }
}

const components = {
  RemoteIcon,
  PluginOverlay,
  HostListView,
  HostCard,
  EmptyHosts,
  ManageWindow,
  ConnectWindow,
  ConnectLog,
  ConnectProgress,
  ErrorCard,
  FingerprintCard,
  PasswordPrompt,
  RemoteConflictPrompt,
  StopRemoteDialog,
  KeyFilePicker,
  WizardDialog,
  DiagnoseDrawer,
  SettingsModal,
  DownloadCenter,
  DownloadProgress,
  StatusDot,
  Modal,
  Button,
  Notice,
  Toast,
}

/**
 * Pure pieces the unit tests drive directly. This is a test seam, not part of the plugin
 * contract: the exported components and `carrier`/`api` stay the only supported surface.
 */
const __test = {
  createDialogStack,
  subscribeState,
  subscribeConnectLog,
  applyLogFrame,
  mergeStatePreservingLogs,
  seedLogsFromSnapshot,
  connectLogVisible,
  connectLogStatuses: CONNECT_LOG_STATUSES,
  stateRevision,
  stateInstance,
  isNewerState,
  // The log channel's paint path (W2): a burst of frames is one paint per display frame. Both
  // halves are pure enough to drive directly - the scheduler is injected, the merge is the real
  // `applyLogFrame` - so the coalescing is proved without a renderer.
  createFrameBatch,
  createLogPump,
  // The password field's Enter gate (W4): React's synthetic event is not required to expose
  // `isComposing`, so the rule is one function over both event shapes.
  passwordEnterSubmits,
  streamRetryDelay,
  initialDraft,
  buildHostInput,
  validateHostDraft,
  validateSettingsDraft,
  settingsPatchFromDraft,
  settingsDraft,
  parseMaskedAddress,
  limits: HOST_LIMITS,
  sanitizeGuestIntent,
  createCarrierErrorLayer,
  createLoadGuard,
  isValidLoopbackUrl,
  loadTimeoutMs: CARRIER_LOAD_TIMEOUT_MS,
  captionMenuStart,
  withTimeout,
  // The i18n seam: `test/unit/i18n.test.ts` proves the two dictionaries agree and drives both
  // fallbacks (requested language missing, key missing everywhere) on the real `t()` factory.
  STRINGS,
  zh,
  en,
  interpolate,
  makeFallbackT,
  localeKey: dictionaryKey,
  localeOf,
  translatorOf,
  resolveText,
  resolveTextList,
  // The second bilingual table: client-side failures are `ErrorView` payloads, not dictionary
  // entries, so their pairs are proved separately (the CJK rule exempts errors.ts for this reason).
  LOCAL_ERRORS,
}

const __drgExport = {
  inject: ['slots', 'locale'],
  apply,
  components,
  __test,
  /**
   * The Host-API client, exposed so unit tests can exercise the real security
   */
  api,
  /** Download intents from the guest bridge, exposed for unit tests. */
  toolRequests: {
    create: createToolRequestStore,
  },
  carrier: {
    open: showOverlay,
    close: closeOverlay,
    closeOne: closeCarrier,
    hide: hideOverlays,
    warm: carrierWarm,
    shown: () => carrierPool.current,
    surface: () => carrierSurface(),
    update: updateSwitcher,
    script: () => HOST_ROW_SCRIPT,
    guestTools: () => GUEST_TOOLS_SCRIPT,
    /** The capability bridge's guest script (desktop carrier) and installer (browser frame). */
    capabilities: () => CAPABILITY_BRIDGE_SCRIPT,
    bridge: (win) => mountCapabilityBridge(win),
    /** Install the per-host `localStorage` partition into one framed page. */
    partition: (win, hostId) => mountGuestStorage(win, hostId),
    /** Guest-side rail watcher, the atomic intent take, and the inset it maps to (issue #63). */
    sidebarMirror: () => SIDEBAR_MIRROR_SCRIPT,
    intentsScript: () => TAKE_INTENTS_SCRIPT,
    captionMenuStart: (collapsed, start) => captionMenuStart(collapsed, start),
  },
}
