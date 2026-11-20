// client/src/plugin.ts - apply(ctx), the components map, the __test face and the plugin face returned to the loader; last module.
interface PluginCtx {
  effect(effect: () => unknown, id: string): unknown
  locale: PluginLocale
  slots: PluginSlots
  get(name: string): PluginWorkspace | null | undefined
}
interface PluginLocale {
  register(namespace: string, dictionaries: Dictionaries): unknown
  bind(namespace: string): Translate
  getSnapshot?: () => { active?: unknown } | null
  getLocale?: () => { active?: unknown } | null
}
interface PluginSlots {
  inject(name: string, factory: () => unknown): unknown
  register(options: SlotOptions, component: unknown): unknown
}
interface SlotOptions {
  name: string
  id: string
  order: number
  locale: string
  inject: () => unknown
}
interface PluginWorkspace {
  pickDirectory?: () => unknown
}
function apply(ctx: PluginCtx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-go: dictionaries')
  const t = ctx.locale.bind(NS)
  // Backfill the Host's version probe when the page exposes it, and start the authoritative `/state` read in parallel.
  ctx.effect(() => {
    const version = readBootVersion()
    if (version) api.reportLocalVersion(version)
    api.getState().catch(() => {})
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
      // swallow-ok: a missing locale snapshot falls back to the default dictionary
    }
    return 'zh'
  }
  const panelStore = createPanelRequestStore()
  // A carrier's failure layer hands the window back to the local page through this hook.
  requestLocalPage = () => panelStore.requestIntent({ kind: 'local' })
  const wizardStore = createWizardStore()
  const toolStore = createToolRequestStore()
  const openWizard = (draft: WizardOpenInput) => {
    wizardStore.open(draft)
  }
  const sharedInject = () =>
    Object.assign(
      { panelStore, wizardStore, toolStore, openWizard, getLocaleId },
      {
        pickDirectory: async () => {
          try {
            const workspaceUi = ctx.get('uiWorkspace')
            if (workspaceUi && typeof workspaceUi.pickDirectory === 'function') {
              const picked = await workspaceUi.pickDirectory()
              return typeof picked === 'string' && picked !== '' ? picked : null
            }
          } catch (_error) {
            // swallow-ok: without the workspace UI the desktop preload picker below is used
          }
          return undefined
        },
      },
    )
  // All of it lives in the shell's overlay layer, above any remote window, so a dialog leaves the remote as it was.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: PANEL_ID, order: 40, locale: NS, inject: sharedInject },
      PluginOverlay,
    ),
  )
  // The window's only host control is the switcher row in the owning page's sidebar: local plus every host.
  // It is the plugin's only host entry, and the ticker is a safety net for a shell that re-rendered the sidebar away.
  ctx.effect(() => {
    switcher.labelsOf = () => ({
      local: t('switcherLocal'),
      addHost: t('switcherAddHost'),
      manage: t('switcherManage'),
      exit: t('switcherExit'),
    })
    updateSwitcher()
    const timer = setInterval(() => updateSwitcher(), SWITCHER_TICK_MS)
    unrefTimer(timer)
    return () => {
      if (typeof clearInterval === 'function') clearInterval(timer)
      switcher.dispatch = null
      switcher.labelsOf = null
      const win = localWindow()
      if (win !== null && win.__drgHostRow && typeof win.__drgHostRow.destroy === 'function') win.__drgHostRow.destroy()
      closeOverlay().catch(() => {})
      switcher.installed = false
    }
  }, 'dsh-remote-go: host switcher row')
  function returnToLocal() {
    switcher.current = 'local'
    updateSwitcher({ current: 'local' })
    hideOverlays()
    panelStore.requestIntent({ kind: 'local' })
  }
  switcher.dispatch = (intent) => {
    const action = intent.action
    // The guest's menu produced a path; the local half does the SFTP read, so no remote bytes cross the bridge.
    if (action === 'download-file') {
      const { hostId, kind, path, name } = intent
      toolStore.requestDownload({ hostId, kind, path, name })
    } else if (action === 'open-external') {
      // A refused URL is the only provable failure: `noopener,noreferrer` makes a successful open return null too.
      if (openExternalUrl(intent.url) === 'blocked') {
        toolStore.requestNotice({ tone: 'error', text: t('externalLinkBlocked') })
      }
    } else if (action === 'clipboard-write') {
      // The write happens here (the framed page cannot hold the permission); this promise is the guest's receipt.
      const text = typeof intent.text === 'string' ? intent.text : ''
      return copyText(text).then(
        (ok) => ({ ok: ok === true }),
        () => ({ ok: false }),
      )
    } else if (action === 'notify') {
      // Known codes map here; free text keeps its origin tag, so a remote notice never reads as local chrome.
      const code = typeof intent.code === 'string' ? intent.code : ''
      let message = ''
      if (code === 'clipboard-failed') message = t('clipboardWriteFailed')
      else if (typeof intent.text === 'string' && intent.text !== '') message = t('remoteNoticePrefix') + intent.text
      if (message !== '') toolStore.requestNotice({ tone: intent.tone === 'error' ? 'error' : 'info', text: message })
    } else if (action === 'add') openWizard({ mode: 'add', host: null })
    else if (action === 'manage') panelStore.requestIntent({ kind: 'manage' })
    else if (action === 'disconnect' && typeof intent.hostId === 'string') {
      panelStore.requestIntent({ kind: 'disconnect', hostId: intent.hostId })
    } else {
      if (typeof intent.target !== 'string') return
      if (intent.target === 'local') returnToLocal()
      else {
        // Say where the window is going at once; the overlay host does the rest.
        switcher.current = intent.target
        updateSwitcher({ current: intent.target })
        panelStore.requestIntent({ kind: 'open', hostId: intent.target })
        api.activate(intent.target).catch(() => {})
      }
    }
  }
}
/** The panel parts the shell renders by name. */
const components = Object.assign(
  { RemoteIcon, PluginOverlay, HostListView, HostCard, EmptyHosts },
  { ManageWindow, ConnectWindow, ConnectLog, ConnectProgress, ErrorCard },
  { FingerprintCard, PasswordPrompt, RemoteConflictPrompt, StopRemoteDialog, KeyFilePicker },
  { WizardDialog, DiagnoseDrawer, SettingsModal, DownloadCenter, DownloadProgress },
  { StatusDot, Modal, Button, Notice, Toast },
)
const __test = Object.assign(
  { createDialogStack, subscribeState, subscribeConnectLog, applyLogFrame, mergeStatePreservingLogs },
  { seedLogsFromSnapshot, connectLogVisible, connectLogStatuses: CONNECT_LOG_STATUSES, stateRevision },
  { stateInstance, isNewerState, createFrameBatch, createLogPump, passwordEnterSubmits, streamRetryDelay },
  { initialDraft, buildHostInput, validateHostDraft, validateSettingsDraft, settingsPatchFromDraft },
  { settingsDraft, parseMaskedAddress, limits: HOST_LIMITS, sanitizeGuestIntent, createCarrierErrorLayer },
  { createLoadGuard, isValidLoopbackUrl, loadTimeoutMs: CARRIER_LOAD_TIMEOUT_MS, captionMenuStart, withTimeout },
  { STRINGS, zh, en, interpolate, makeFallbackT, localeKey: dictionaryKey, localeOf },
  { translatorOf, resolveText, resolveTextList, LOCAL_ERRORS },
)
const __drgExport = {
  inject: ['slots', 'locale'],
  apply,
  components,
  __test,
  api,
  toolRequests: { create: createToolRequestStore },
  carrier: Object.assign(
    { open: showOverlay, close: closeOverlay, closeOne: closeCarrier, hide: hideOverlays, warm: carrierWarm },
    { shown: () => carrierPool.current, surface: () => carrierSurface(), update: updateSwitcher },
    {
      script: () => HOST_ROW_SCRIPT,
      guestTools: () => GUEST_TOOLS_SCRIPT,
      capabilities: () => CAPABILITY_BRIDGE_SCRIPT,
    },
    {
      bridge: (win: Window) => mountCapabilityBridge(win),
      partition: (win: Window, hostId: unknown) => mountGuestStorage(win, hostId),
    },
    { sidebarMirror: () => SIDEBAR_MIRROR_SCRIPT, intentsScript: () => TAKE_INTENTS_SCRIPT },
    { captionMenuStart: (collapsed: unknown, start?: unknown) => captionMenuStart(collapsed, start) },
  ),
}
