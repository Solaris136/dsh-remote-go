// client/src/plugin-overlay.ts - PluginOverlay: the overlay host's state, effects and render (its commands live in actions.ts); after actions.ts, before styles.ts.
/** One job frame as the `/state` feed delivers it; the handler is swapped per render. */
interface DownloadHandler {
  (job: DownloadJobView): void
}

/**
 * The overlay host: everything that is not the sidebar row. It sits above the remote window,
 * so opening or closing a dialog never changes what is behind it.
 */
function PluginOverlay(props: PluginOverlayProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  // One `/state` feed for the whole plugin (docs/api.md): the row, the windows and the
  // remote window all read from it. Download jobs arrive on the same SSE stream.
  const [downloadJobs, setDownloadJobs] = useState<Record<string, DownloadCardView>>({})
  const downloadJobsRef = useRef<Record<string, DownloadCardView>>({})
  const downloadPolls = useRef<Map<string, TimerHandle>>(new Map())
  const downloadRemoval = useRef<Map<string, TimerHandle>>(new Map())
  const downloadHandlerRef = useRef<DownloadHandler>(() => {})
  const remote = useRemoteState(props.initialState, (job: DownloadJobView) => downloadHandlerRef.current(job))
  const state = remote.state
  const [target, setTarget] = useState<string | null>(() => {
    const initial = props.initialState
    return initial && typeof initial.activeHostId === 'string' ? initial.activeHostId : null
  })
  const [manageOpen, setManageOpen] = useState(false)
  /** Which body the floating window shows. Separate from the host status: 管理界面 always brings the list back. */
  const [manageView, setManageView] = useState<string>('list')
  /**
   * Which host the connect window (progress + log) belongs to. Opening a host sets it, and so
   * do reconnect and restart: those are the same kind of link work, and the window is where
   * their progress and log are visible.
   */
  const [connectHostId, setConnectHostId] = useState<string | null>(null)
  // The loopback URL the guest loads (GET /hosts/:id/open); it carries the
  // one-shot launch token, so it is fetched on demand and never persisted.
  const [remoteUrl, setRemoteUrl] = useState<RemoteUrlState | null>(null)
  const [busyHostId, setBusyHostId] = useState<string | null>(null)
  const [diagnose, setDiagnose] = useState<DiagnoseState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<HostLike | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Deleting a host whose link is being built needs a second, explicit confirmation.
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPromptState | null>(null)
  // Synchronous guard: two Enter events in the same tick both see `pending.busy === false`
  // because React has not re-rendered yet, so the ref is what makes the submit idempotent.
  const passwordBusy = useRef(false)
  const [conflictBusy, setConflictBusy] = useState(false)
  const [fingerprintBusy, setFingerprintBusy] = useState(false)
  // A queue, not one slot: a second message used to replace the first before it could be
  // read (audit S3). Newest last, at most three, each with its own dismissal timer.
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
  useEffect(
    () => () => {
      for (const timer of toastTimers.current.values()) {
        if (typeof clearTimeout === 'function') clearTimeout(timer)
      }
      toastTimers.current.clear()
    },
    [],
  )
  const errorMessage = (error: unknown) => {
    const viewOfError = toErrorView(error)
    const title = resolveText(viewOfError.title, locale)
    const detail = resolveText(viewOfError.detail, locale)
    return detail ? title + ' ' + detail : title
  }

  useEffect(
    () => () => {
      for (const timer of downloadPolls.current.values()) {
        if (typeof clearInterval === 'function') clearInterval(timer)
      }
      for (const timer of downloadRemoval.current.values()) {
        if (typeof clearTimeout === 'function') clearTimeout(timer)
      }
      downloadPolls.current.clear()
      downloadRemoval.current.clear()
    },
    [],
  )

  const hosts: HostView[] = state && Array.isArray(state.hosts) ? state.hosts : []
  const conflictHost = hosts.find((host) => host && host.status === 'conflict-pending' && host.conflict) || null
  const activeHost = target ? hosts.find((host) => host && host.id === target) || null : null
  // The connect body names one host explicitly: a restart / reconnect of a host that is not
  // the one filling the window must still show that host's progress and log.
  const connectHost =
    connectHostId !== null ? hosts.find((host) => host && host.id === connectHostId) || null : activeHost
  const activeStatus = activeHost ? activeHost.status : null
  /**
   * Which attach the remote window belongs to. `remote.viewRev` changes on every successful
   * connect / restart / re-attach, so a warm carrier built for an older tunnel is stale even
   * though its host is connected again.
   */
  const activeViewRev =
    activeHost && activeHost.remote && Number.isInteger(activeHost.remote.viewRev) ? activeHost.remote.viewRev : null
  /** True when the warm carrier was navigated for the given attach. */
  const carrierHoldsView = (hostId: string, viewRev: number | null) => {
    const entry = carrierOf(hostId)
    if (entry === null) return false
    const entryRev = Number.isInteger(entry.viewRev) ? entry.viewRev : null
    return entryRev === viewRev
  }
  /**
   * The connect-log channel (docs/api.md `GET /events/logs`): one multiplexed stream for every
   * host with a connect window, opened only while one exists. Rows arrive here; the state channel
   * keeps the revision gate, the polling fallback and the degraded banner.
   */
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

  // The commands live in `actions.ts`; they are built from this render's state so every closure
  // sees the same values the inline declarations did.
  const {
    applyIntent,
    downloadFromHost,
    startDownloadPoll,
    showConnectWindow,
    openHost,
    disconnectHost,
    reconnectHost,
    restartHost,
    stopRemoteHost,
    resolveConflict,
    runDiagnose,
    rerunDiagnose,
    confirmDeleteHost,
    saveSettings,
    answerFingerprint,
    openWizard,
    cancelDownloadJob,
    removeDownloadView,
  } = createOverlayActions({
    props,
    t,
    locale,
    notify,
    errorMessage,
    remote,
    downloadJobsRef,
    setDownloadJobs,
    downloadPolls,
    downloadRemoval,
    downloadHandlerRef,
    target,
    setTarget,
    setManageOpen,
    setManageView,
    setConnectHostId,
    setRemoteUrl,
    setBusyHostId,
    diagnose,
    setDiagnose,
    pendingDelete,
    setPendingDelete,
    deleting,
    setDeleting,
    deleteArmed,
    setDeleteArmed,
    setPasswordPrompt,
    setConflictBusy,
    setFingerprintBusy,
    hostsRef,
    pendingSwitch,
    pendingIntent,
  })

  // A host removed elsewhere closes its window instead of leaving a blank frame.
  useEffect(() => {
    if (target === null || state === null) return
    if (!hosts.some((host) => host && host.id === target)) setTarget(null)
  }, [state, target])

  // The launch URL is bound to the host it was issued for: a URL for another host is
  // worth nothing (it is one-shot and host-specific), so it can never reach a window.
  useEffect(() => {
    if (activeStatus === 'connecting') setRemoteUrl(null)
  }, [activeStatus])

  // Fetch `GET /hosts/:id/open` only for a host that is up and not already warm for this
  // attach: the carrier needs the launch-token URL once, and a warm window is shown without it.
  // A cached URL from an older `viewRev` is stale even for the same host (its token and
  // tunnel are gone), so it is refetched rather than replayed.
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
        if (cancelled) return
        notify(errorMessage(error), 'error')
      },
    )
    return () => {
      cancelled = true
    }
  }, [target, activeStatus, remoteUrl, activeViewRev])

  // Where the window is. Guests stay warm: a warm one is shown again without any load,
  // which is what makes switching between remotes (and coming back from local) instant.
  useEffect(() => {
    if (target === null) {
      hideOverlays()
      return
    }
    if (activeStatus !== 'connected') {
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
    // The launch URL for *this* host is still being fetched: keep the current carrier up
    // so switching does not flash the local UI behind it.
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
    // `showOverlay` is async, so the acquire outcome only arrives through its promise; a
    // failed acquire still has to reach the toast even though nothing awaits it here.
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

  // When the host we asked for comes up, the window switches and the connect window gets
  // out of the way; a failure left it up (with its error and the log) until it is closed.
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

  // While the state stream is down, download cards must keep moving from a status poll:
  // SSE `download` frames are exactly what stops arriving in fallback mode (audit S2-1).
  useEffect(() => {
    if (remote.mode !== 'polling' && remote.mode !== 'reconnecting') return
    for (const id of Object.keys(downloadJobsRef.current)) {
      const job = downloadJobsRef.current[id]
      if (!job || job.phase === 'saving' || job.phase === 'done' || job.phase === 'error') continue
      startDownloadPoll(id)
    }
  }, [remote.mode])

  // The management window's footer banner is not visible while a remote carrier fills the
  // window. Surface the same degradation through the shell's toast so it is visible on the
  // local page and over a guest, and announce the recovery (review feedback).
  const lastStreamMode = useRef<StreamMode>('idle')
  useEffect(() => {
    const degraded = remote.mode === 'polling' || remote.mode === 'reconnecting'
    const wasDegraded = lastStreamMode.current === 'polling' || lastStreamMode.current === 'reconnecting'
    if (degraded && !wasDegraded) notify(t('liveStreamLostTitle'), 'warn')
    else if (remote.mode === 'live' && wasDegraded) notify(t('liveStreamRestored'), 'success')
    lastStreamMode.current = remote.mode
  }, [remote.mode])

  useEffect(() => {
    const store = props.panelStore
    if (!store || typeof store.take !== 'function' || typeof store.subscribe !== 'function') return undefined
    const consume = () => applyIntent(store.take())
    consume()
    return store.subscribe(consume)
  }, [props.panelStore])
  useEffect(() => {
    if (pendingIntent.current === null) return
    applyIntent(pendingIntent.current)
  }, [state])

  // The wizard is driven by its own store so it can be opened from anywhere.
  useEffect(() => {
    const store = props.wizardStore
    if (!store || typeof store.subscribe !== 'function') return undefined
    const sync = () => setWizard(typeof store.current === 'function' ? store.current() : null)
    sync()
    return store.subscribe(sync)
  }, [props.wizardStore])
  // Guest file intents arrive through the same command channel as the wizard's
  // requests; drain in order, with a small cap so a malformed producer cannot spin.
  useEffect(() => {
    const store = props.toolStore
    if (!store || typeof store.subscribe !== 'function') return undefined
    const consume = () => {
      for (let index = 0; index < 8; index += 1) {
        const request = typeof store.take === 'function' ? store.take() : null
        if (!request) return
        if (request.kind === 'download') downloadFromHost(request)
        // The capability bridge has no toast of its own: a refused copy is reported here,
        // where the shell already owns one.
        else if (request.kind === 'notice') notify(request.text, request.tone)
      }
    }
    consume()
    return store.subscribe(consume)
  }, [props.toolStore])
  const closeWizard = () => {
    const store = props.wizardStore
    if (store && typeof store.close === 'function') store.close()
  }

  const submitPassword = (submitted: PasswordSubmission) => {
    const pending = passwordPrompt
    // The prompt's own handler guards Enter, but the doubling in the audit came from two
    // events in the same tick; the store-level guard is the last line (S2-2).
    if (!pending || !pending.host || pending.busy === true || passwordBusy.current === true) return
    const value = submitted && typeof submitted.password === 'string' ? submitted.password : ''
    const remember = submitted && submitted.remember === true
    if (value.trim() === '') {
      setPasswordPrompt({ ...pending, error: t('passwordPromptRequired') })
      return
    }
    passwordBusy.current = true
    const host = pending.host
    const intent = pending.intent
    if (intent === 'open') {
      showConnectWindow(host)
      setTarget(host.id)
    }
    if (intent === 'reconnect') {
      setRemoteUrl(null)
      // The reconnect itself is the same link work the connect window explains.
      showConnectWindow(host)
    }
    setPasswordPrompt({ ...pending, busy: true, error: null })
    setBusyHostId(host.id)
    const connect =
      intent === 'reconnect'
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
    // The row moved to that host when it was picked; the switch was cancelled, so put
    // it back where the window actually is.
    passwordBusy.current = false
    pendingSwitch.current = null
    updateSwitcher({ current: target === null ? 'local' : target })
    setPasswordPrompt(null)
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
          onCancel: cancelDownloadJob,
          onDismiss: (job) => removeDownloadView(job.id),
        })
      : null,
    h(ManageWindow, {
      open: manageOpen,
      view: manageView,
      t,
      locale,
      // The connect body names its own host, so restarting or reconnecting a host that is
      // not the one filling the window still shows that host's progress and log.
      host: connectHost,
      state,
      loading: remote.loading,
      error: remote.error,
      busyHostId,
      mode: remote.mode,
      onRetryLive: retryLive,
      fingerprintBusy,
      onClose: () => {
        // The connect body is per-visit: closing the window must not leave a stale host
        // behind for the next one (the link work itself keeps running).
        setManageOpen(false)
        setConnectHostId(null)
      },
      onShowList: () => setManageView('list'),
      onAdd: () => openWizard({ mode: 'add', host: null }),
      onRefresh: remote.refresh,
      onOpenSettings: () => setSettingsOpen(true),
      onOpenHost: openHost,
      onDisconnectHost: disconnectHost,
      onReconnectHost: reconnectHost,
      onRestartHost: restartHost,
      onStopRemoteHost: stopRemoteHost,
      onEditHost: (host) => openWizard({ mode: 'edit', host }),
      onDeleteHost: (host) => {
        setDeleteArmed(false)
        setPendingDelete(host)
      },
      onDiagnoseHost: runDiagnose,
      onAcceptFingerprint: (host, remember) => answerFingerprint(host, true, remember === true),
      onRejectFingerprint: (host) => answerFingerprint(host, false, false),
      onRetry: (host) => reconnectHost(host),
      onDiagnose: (host) => runDiagnose(host),
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
          // Connect from the dialog: it saved the entry, so hand the connection over here.
          // The window is the connect window from the first frame on — progress, host key
          // and log — and the remote takes over as soon as it is up.
          onConnect: (host, password, rememberPassword) => {
            closeWizard()
            openHost(host, password === null ? {} : { password, rememberPassword: rememberPassword === true })
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
          onRun: rerunDiagnose,
        })
      : null,
    settingsOpen && state
      ? h(SettingsModal, {
          t,
          locale,
          settings: state.settings,
          onClose: () => setSettingsOpen(false),
          onSave: saveSettings,
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
          onConfirm: confirmDeleteHost,
          onCancel: () => {
            if (deleting) return
            setDeleteArmed(false)
            setPendingDelete(null)
          },
        })
      : null,
    conflictHost
      ? h(RemoteConflictPrompt, {
          key: conflictHost.id,
          t,
          host: conflictHost,
          busy: conflictBusy,
          onResolve: resolveConflict,
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
          storageAvailable: passwordPrompt.host ? passwordPrompt.host.passwordStorageAvailable === true : false,
          onSubmit: submitPassword,
          onCancel: cancelPassword,
        })
      : null,
    h(Toast, { toasts }),
  )
}
