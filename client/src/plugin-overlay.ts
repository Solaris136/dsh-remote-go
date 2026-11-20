// client/src/plugin-overlay.ts - PluginOverlay: the overlay host's state, effects and render (its commands live in actions.ts); after actions.ts, before styles.ts.
/** The one member the overlay host needs from every panel store it drains. */
type StoreSource = { subscribe: (listener: () => void) => () => void }
/** Run `drain` once at mount and again on every store change: every store the shell hands down is consumed this way. */
function subscribeStore(store: StoreSource | null | undefined, drain: () => void) {
  if (!store || typeof store.subscribe !== 'function') return undefined
  drain()
  return store.subscribe(drain)
}
/** Polling or reconnecting: the live stream is degraded, which the shell's toast has to say where no banner is visible. */
const streamDegraded = (mode: StreamMode) => mode === 'polling' || mode === 'reconnecting'
/** Everything but the sidebar row: it sits above the remote window, so a dialog never changes what is behind it. */
// One `/state` feed (docs/api.md) serves the row and the windows, and download jobs ride the same SSE stream.
function PluginOverlay(props: PluginOverlayProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const [downloadJobs, setDownloadJobs] = useState<Record<string, DownloadCardView>>({})
  const downloadJobsRef = useRef<Record<string, DownloadCardView>>({})
  const downloadPolls = useRef<Map<string, TimerHandle>>(new Map())
  const downloadRemoval = useRef<Map<string, TimerHandle>>(new Map())
  const downloadHandlerRef = useRef<(job: DownloadJobView) => void>(() => {})
  const remote = useRemoteState(props.initialState, (job: DownloadJobView) => downloadHandlerRef.current(job))
  const state = remote.state
  const [target, setTarget] = useState<string | null>(() => {
    const initial = props.initialState
    return initial && typeof initial.activeHostId === 'string' ? initial.activeHostId : null
  })
  const [manageOpen, setManageOpen] = useState(false)
  /** Which body the floating window shows; separate from the host status, so the management seat brings the list back. */
  const [manageView, setManageView] = useState<string>('list')
  /** Which host the connect window belongs to: opening, reconnecting and restarting all name it explicitly. */
  const [connectHostId, setConnectHostId] = useState<string | null>(null)
  // The loopback launch URL (`GET /hosts/:id/open`) carries a one-shot token: fetched on demand, never persisted.
  const [remoteUrl, setRemoteUrl] = useState<RemoteUrlState | null>(null)
  const [busyHostId, setBusyHostId] = useState<string | null>(null)
  const [diagnose, setDiagnose] = useState<DiagnoseState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<HostLike | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Deleting a host whose link is being built needs a second, explicit confirmation.
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPromptState | null>(null)
  // Synchronous guard: two Enters in one tick both see `pending.busy === false`, so the ref makes it idempotent.
  const passwordBusy = useRef(false)
  const [conflictBusy, setConflictBusy] = useState(false)
  const [fingerprintBusy, setFingerprintBusy] = useState(false)
  // A queue, not one slot (a second message used to replace the first): newest last, at most three, each timed.
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const toastSeq = useRef(0)
  const toastTimers = useRef<Map<number, TimerHandle>>(new Map())
  const [wizard, setWizard] = useState<HostDraft | null>(() => {
    const store = props.wizardStore
    return store && typeof store.current === 'function' ? store.current() : null
  })

  const dismissToast = (id: number) => {
    const timer = toastTimers.current.get(id)
    if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer)
    toastTimers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }
  const notify = (text: ReactNode, tone?: Tone) => {
    toastSeq.current += 1
    const id = toastSeq.current
    setToasts((current) => [...current, { id, text, tone: tone || 'info' }].slice(-3))
    if (typeof setTimeout === 'function') {
      const timer = setTimeout(() => dismissToast(id), 4200)
      unrefTimer(timer)
      toastTimers.current.set(id, timer)
    }
  }
  // One unmount cleanup for every timer this page owns: the toast dismissals, the download polls and the removals.
  useEffect(
    () => () => {
      toastTimers.current.forEach((timer) => {
        if (typeof clearTimeout === 'function') clearTimeout(timer)
      })
      downloadPolls.current.forEach((timer) => {
        if (typeof clearInterval === 'function') clearInterval(timer)
      })
      downloadRemoval.current.forEach((timer) => {
        if (typeof clearTimeout === 'function') clearTimeout(timer)
      })
      toastTimers.current.clear()
      downloadPolls.current.clear()
      downloadRemoval.current.clear()
    },
    [],
  )
  const errorMessage = (error: unknown) => {
    const viewOfError = toErrorView(error)
    const title = resolveText(viewOfError.title, locale)
    const detail = resolveText(viewOfError.detail, locale)
    return detail ? title + ' ' + detail : title
  }

  const hosts: HostView[] = state && Array.isArray(state.hosts) ? state.hosts : []
  const conflictHost = hosts.find((host) => host && host.status === 'conflict-pending' && host.conflict) || null
  const activeHost = target ? hosts.find((host) => host && host.id === target) || null : null
  // The connect body names one host, so a restart of any other host still shows that host's progress and log.
  const connectHost =
    connectHostId !== null ? hosts.find((host) => host && host.id === connectHostId) || null : activeHost
  const activeStatus = activeHost ? activeHost.status : null
  // The attach the window belongs to: `viewRev` moves per connect/restart, so a warm carrier for an old one is stale.
  const activeViewRev =
    activeHost && activeHost.remote && Number.isInteger(activeHost.remote.viewRev) ? activeHost.remote.viewRev : null
  /** True when the warm carrier was navigated for the given attach. */
  const carrierHoldsView = (hostId: string, viewRev: number | null) => {
    const entry = carrierOf(hostId)
    if (entry === null) return false
    const entryRev = Number.isInteger(entry.viewRev) ? entry.viewRev : null
    return entryRev === viewRev
  }
  // The connect-log channel: one multiplexed stream for the hosts with a connect window, opened only while one exists.
  const reconnectConnectLog = useConnectLogStream(remote)
  /** The banner's retry reconnects both channels; the log one only when it is in use. */
  const retryLive = () => {
    remote.reconnectStream()
    reconnectConnectLog()
  }
  const hostsRef = useRef<HostView[]>(hosts)
  hostsRef.current = hosts
  // A host we asked for that still has to connect: the list stays up until it is ready.
  const pendingSwitch = useRef<string | null>(null)
  const pendingIntent = useRef<PanelRequest | null>(null)
  // Host we already told the user cannot be shown here (no desktop window seat).
  const noWindowNotified = useRef<string | null>(null)
  // The commands live in `actions.ts`, rebuilt each render so every closure sees its state; deps are grouped by kind.
  const actions = createOverlayActions(
    Object.assign(
      { props, t, locale, notify, errorMessage, remote },
      { downloadJobsRef, setDownloadJobs, downloadPolls, downloadRemoval, downloadHandlerRef },
      { target, setTarget, setManageOpen, setManageView, setConnectHostId, setRemoteUrl, setBusyHostId },
      { diagnose, setDiagnose, pendingDelete, setPendingDelete, deleting, setDeleting, deleteArmed, setDeleteArmed },
      { setPasswordPrompt, setConflictBusy, setFingerprintBusy, hostsRef, pendingSwitch, pendingIntent },
    ),
  )
  // A host removed elsewhere closes its window instead of leaving a blank frame.
  useEffect(() => {
    if (target === null || state === null) return
    if (!hosts.some((host) => host && host.id === target)) setTarget(null)
  }, [state, target])

  // The launch URL is bound to the host it was issued for: a URL for another host is worth nothing (it is one-shot).
  useEffect(() => {
    if (activeStatus === 'connecting') setRemoteUrl(null)
  }, [activeStatus])

  // Fetch the launch URL only for a host that is up and not warm for this attach: one from an older `viewRev` is stale.
  useEffect(() => {
    if (target === null || carrierHoldsView(target, activeViewRev)) return undefined
    if (remoteUrl !== null && remoteUrl.hostId === target && remoteUrl.viewRev === activeViewRev) return undefined
    if (activeStatus !== 'connected') return undefined
    let cancelled = false
    api.openHost(target).then(
      (opened) => {
        if (!cancelled) setRemoteUrl({ hostId: target, url: opened.url, webUrl: opened.webUrl, viewRev: activeViewRev })
      },
      (error) => {
        if (!cancelled) notify(errorMessage(error), 'error')
      },
    )
    return () => {
      cancelled = true
    }
  }, [target, activeStatus, remoteUrl, activeViewRev])

  // Where the window is. A warm guest is shown again without any load, which is what makes switching instant.
  useEffect(() => {
    if (target === null || activeStatus !== 'connected') {
      hideOverlays()
      return
    }
    if (carrierHoldsView(target, activeViewRev)) {
      showOverlay({
        hostId: target,
        message: t('viewportOverlayLoadFailed'),
        localLabel: t('carrierBackToLocal'),
        viewRev: activeViewRev,
      })
      return
    }
    // That launch URL is still being fetched: keep the carrier up so switching does not flash the local UI.
    if (remoteUrl === null || remoteUrl.hostId !== target) return
    // Never replay a launch URL issued for an older attach (its token and tunnel are gone).
    if (activeViewRev !== null && remoteUrl.viewRev !== activeViewRev) return
    const surface = carrierSurface()
    const carrierUrl = surface === 'desktop' ? remoteUrl.url : remoteUrl.webUrl
    if (surface === 'web' && (typeof carrierUrl !== 'string' || carrierUrl === '')) {
      if (noWindowNotified.current !== target) {
        noWindowNotified.current = target
        notify(t('carrierUnavailable'), 'error')
      }
      return
    }
    // `showOverlay` is async: a failed acquire only arrives through its promise, which still has to reach the toast.
    showOverlay({
      hostId: target,
      url: carrierUrl,
      message: t('viewportOverlayLoadFailed'),
      localLabel: t('carrierBackToLocal'),
      viewRev: remoteUrl.viewRev,
    }).then(
      (outcome) => {
        if (!outcome || outcome.ok !== false || outcome.reason !== 'acquire-failed') return
        if (noWindowNotified.current === target) return
        noWindowNotified.current = target
        notify(t('carrierUnavailable'), 'error')
      },
      () => {},
    )
  }, [target, activeStatus, remoteUrl, activeViewRev])

  // When the asked-for host comes up the window switches; a failure leaves the connect window up, error and log shown.
  useEffect(() => {
    if (target === null || activeStatus !== 'connected' || pendingSwitch.current !== target) return
    pendingSwitch.current = null
    setManageView('list')
    setManageOpen(false)
  }, [target, activeStatus])

  // The row shows where the window is and which hosts are up; both live in `state`.
  useEffect(() => {
    updateSwitcher({ hosts })
  }, [state])
  useEffect(() => {
    updateSwitcher({ current: target === null ? 'local' : target })
  }, [target])

  // A host that is gone (or was closed) must not keep a hidden renderer alive.
  useEffect(() => {
    if (state === null) return
    for (const entry of carrierPool.entries.slice()) {
      const host = hosts.find((item) => item && item.id === entry.hostId) || null
      if (host !== null && (host.status === 'connected' || host.status === 'connecting')) continue
      closeCarrier(entry.hostId).catch(() => {})
    }
  }, [state])

  // While the plugin is loaded its windows stay warm; the plugin's own disposal (in `apply`) tears them down.
  useEffect(() => {
    onCarrierDisposed = (hostId) => {
      setRemoteUrl((current) => (current !== null && current.hostId === hostId ? null : current))
    }
    return () => {
      onCarrierDisposed = null
      hideOverlays()
    }
  }, [])

  // While the stream is down, cards keep moving from a status poll: SSE `download` frames are what stops arriving.
  useEffect(() => {
    if (!streamDegraded(remote.mode)) return
    for (const id of Object.keys(downloadJobsRef.current)) {
      const job = downloadJobsRef.current[id]
      if (!job || job.phase === 'saving' || job.phase === 'done' || job.phase === 'error') continue
      actions.startDownloadPoll(id)
    }
  }, [remote.mode])

  // That banner is invisible under a remote carrier, so the same degradation reaches the shell's toast on any page.
  const lastStreamMode = useRef<StreamMode>('idle')
  useEffect(() => {
    const degraded = streamDegraded(remote.mode)
    const wasDegraded = streamDegraded(lastStreamMode.current)
    if (degraded && !wasDegraded) notify(t('liveStreamLostTitle'), 'warn')
    else if (remote.mode === 'live' && wasDegraded) notify(t('liveStreamRestored'), 'success')
    lastStreamMode.current = remote.mode
  }, [remote.mode])

  useEffect(() => {
    const store = props.panelStore
    if (!store || typeof store.take !== 'function') return undefined
    return subscribeStore(store, () => actions.applyIntent(store.take()))
  }, [props.panelStore])
  useEffect(() => {
    if (pendingIntent.current !== null) actions.applyIntent(pendingIntent.current)
  }, [state])

  // The wizard is driven by its own store so it can be opened from anywhere.
  useEffect(() => {
    const store = props.wizardStore
    return subscribeStore(store, () => setWizard(typeof store.current === 'function' ? store.current() : null))
  }, [props.wizardStore])
  // Guest file intents share the wizard's channel: drain in order, with a small cap so a bad producer cannot spin.
  useEffect(() => {
    const store = props.toolStore
    return subscribeStore(store, () => {
      for (let index = 0; index < 8; index += 1) {
        const request = typeof store.take === 'function' ? store.take() : null
        if (!request) return
        if (request.kind === 'download') actions.downloadFromHost(request)
        // The capability bridge has no toast of its own: a refused copy is reported here, where the shell owns one.
        else if (request.kind === 'notice') notify(request.text, request.tone)
      }
    })
  }, [props.toolStore])
  const closeWizard = () => {
    const store = props.wizardStore
    if (store && typeof store.close === 'function') store.close()
  }

  const submitPassword = (submitted: PasswordSubmission) => {
    const pending = passwordPrompt
    // The prompt guards Enter itself, but two events in one tick doubled it; this store-level guard is the last line.
    if (!pending || !pending.host || pending.busy === true || passwordBusy.current === true) return
    const value = submitted && typeof submitted.password === 'string' ? submitted.password : ''
    const remember = submitted && submitted.remember === true
    if (value.trim() === '') {
      setPasswordPrompt({ ...pending, error: t('passwordPromptRequired') })
      return
    }
    passwordBusy.current = true
    const host = pending.host
    if (pending.intent === 'open') {
      actions.showConnectWindow(host)
      setTarget(host.id)
    }
    if (pending.intent === 'reconnect') {
      setRemoteUrl(null)
      // The reconnect itself is the same link work the connect window explains.
      actions.showConnectWindow(host)
    }
    setPasswordPrompt({ ...pending, busy: true, error: null })
    setBusyHostId(host.id)
    const connect =
      pending.intent === 'reconnect'
        ? api
            .disconnect(host.id, false)
            .catch(() => {})
            .then(() => api.connect(host.id, { password: value, rememberPassword: remember }))
        : api.connect(host.id, { password: value, rememberPassword: remember })
    connect
      .then(
        () => {
          setPasswordPrompt(null)
          remote.refresh()
        },
        (error) => {
          const message = errorMessage(error)
          setPasswordPrompt((current) => (current ? { ...current, busy: false, error: message } : current))
          notify(message, 'error')
        },
      )
      .finally(() => {
        passwordBusy.current = false
        setBusyHostId(null)
      })
  }
  const cancelPassword = () => {
    // The row moved to that host when it was picked; the switch was cancelled, so put it back where the window is.
    passwordBusy.current = false
    pendingSwitch.current = null
    updateSwitcher({ current: target === null ? 'local' : target })
    setPasswordPrompt(null)
  }
  /** Closing the connect body is per-visit: the link work itself keeps running. */
  const hideConnect = () => {
    setManageOpen(false)
    setConnectHostId(null)
  }
  const askDelete = (host: HostView) => {
    setDeleteArmed(false)
    setPendingDelete(host)
  }
  const forgetHost = () => {
    setDeleteArmed(false)
    setPendingDelete(null)
  }

  return h(
    'div',
    { className: 'drg-root drg-overlay', 'data-testid': 'dsh-remote-go-overlay-host' },
    h(PanelStyleSheet),
    Object.keys(downloadJobs).length > 0
      ? h(DownloadCenter, {
          jobs: Object.values(downloadJobs),
          t,
          locale,
          onCancel: actions.cancelDownloadJob,
          onDismiss: (job) => actions.removeDownloadView(job.id),
        })
      : null,
    h(ManageWindow, {
      open: manageOpen,
      view: manageView,
      t,
      locale,
      // The connect body names its own host, so restarting another host still shows that host's progress and log.
      host: connectHost,
      state,
      loading: remote.loading,
      error: remote.error,
      busyHostId,
      mode: remote.mode,
      onRetryLive: retryLive,
      fingerprintBusy,
      onClose: hideConnect,
      onShowList: () => setManageView('list'),
      onAdd: () => actions.openWizard({ mode: 'add', host: null }),
      onRefresh: remote.refresh,
      onOpenSettings: () => setSettingsOpen(true),
      onOpenHost: actions.openHost,
      // A connecting host is not reconnected here: its card reopens the connect window, so closing it never strands it.
      onViewProgress: (host: HostView) => actions.openHost(host),
      onDisconnectHost: actions.disconnectHost,
      onReconnectHost: actions.reconnectHost,
      onRestartHost: actions.restartHost,
      onStopRemoteHost: actions.stopRemoteHost,
      onEditHost: (host: HostView) => actions.openWizard({ mode: 'edit', host }),
      onDeleteHost: askDelete,
      onDiagnoseHost: actions.runDiagnose,
      onAcceptFingerprint: (host: HostView, remember: boolean) =>
        actions.answerFingerprint(host, true, remember === true),
      onRejectFingerprint: (host: HostView) => actions.answerFingerprint(host, false, false),
      onRetry: (host: HostView) => actions.reconnectHost(host),
      onDiagnose: (host: HostView) => actions.runDiagnose(host),
    }),
    wizard
      ? h(WizardDialog, {
          key: (wizard.mode || 'add') + ':' + (wizard.host ? wizard.host.id : 'new'),
          t,
          locale,
          mode: wizard.mode,
          initialHost: wizard.host,
          state,
          onClose: closeWizard,
          onRefresh: remote.refresh,
          onSaved: (_saved, warning) => notify(warning || t('wizard.saved'), warning ? 'warn' : 'success'),
          // Connect from the dialog: the entry is saved, so the connect body shows at once and the remote takes over.
          onConnect: (host, password, rememberPassword) => {
            closeWizard()
            actions.openHost(host, password === null ? {} : { password, rememberPassword: rememberPassword === true })
          },
        })
      : null,
    diagnose
      ? h(DiagnoseDrawer, {
          t,
          locale,
          host: diagnose.host,
          status: diagnose.status,
          report: diagnose.report,
          error: diagnose.error,
          onClose: () => setDiagnose(null),
          onRun: actions.rerunDiagnose,
        })
      : null,
    settingsOpen && state
      ? h(SettingsModal, {
          t,
          locale,
          settings: state.settings,
          onClose: () => setSettingsOpen(false),
          onSave: actions.saveSettings,
        })
      : null,
    pendingDelete
      ? h(ConfirmDialog, {
          title: t('deleteTitle'),
          testId: 'delete-dialog',
          body:
            t('deleteBody', { name: pendingDelete.name || pendingDelete.id }) +
            (pendingDelete.status === 'connecting' ? ' ' + t('deleteConnectingWarning') : ''),
          confirmLabel: deleting
            ? t('deleteBusy')
            : pendingDelete.status === 'connecting' && deleteArmed !== true
              ? t('deleteStillConfirm')
              : t('deleteConfirm'),
          cancelLabel: t('cancel'),
          busy: deleting,
          onConfirm: actions.confirmDeleteHost,
          onCancel: () => {
            if (deleting) return
            forgetHost()
          },
        })
      : null,
    conflictHost
      ? h(RemoteConflictPrompt, {
          key: conflictHost.id,
          t,
          host: conflictHost,
          busy: conflictBusy,
          onResolve: actions.resolveConflict,
        })
      : null,
    passwordPrompt
      ? h(PasswordPrompt, {
          key: passwordPrompt.host && passwordPrompt.host.id ? passwordPrompt.host.id : 'password',
          t,
          locale,
          host: passwordPrompt.host,
          busy: passwordPrompt.busy === true,
          error: passwordPrompt.error,
          // No storage of a password is offered where the shell cannot write one.
          storageAvailable: passwordPrompt.host ? passwordPrompt.host.passwordStorageAvailable === true : false,
          onSubmit: submitPassword,
          onCancel: cancelPassword,
        })
      : null,
    h(Toast, { toasts }),
  )
}
