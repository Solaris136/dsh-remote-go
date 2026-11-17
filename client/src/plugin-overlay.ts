// client/src/plugin-overlay.ts - PluginOverlay, the overlay host for every dialog and the remote window (one indissoluble function); after manage-window.ts, before styles.ts.
/**
 * The overlay host: everything that is not the sidebar row. It sits above the remote window,
 * so opening or closing a dialog never changes what is behind it.
 */
function PluginOverlay(props) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  // One `/state` feed for the whole plugin (docs/api.md): the row, the windows and the
  // remote window all read from it. Download jobs arrive on the same SSE stream.
  const [downloadJobs, setDownloadJobs] = useState({})
  const downloadJobsRef = useRef({})
  const downloadPolls = useRef(new Map())
  const downloadRemoval = useRef(new Map())
  const downloadHandlerRef = useRef(() => {})
  const remote = useRemoteState(props.initialState, (job) => downloadHandlerRef.current(job))
  const state = remote.state
  const [target, setTarget] = useState(() => {
    const initial = props.initialState
    return initial && typeof initial.activeHostId === 'string' ? initial.activeHostId : null
  })
  const [manageOpen, setManageOpen] = useState(false)
  /** Which body the floating window shows. Separate from the host status: 管理界面 always brings the list back. */
  const [manageView, setManageView] = useState('list')
  /**
   * Which host the connect window (progress + log) belongs to. Opening a host sets it, and so
   * do reconnect and restart: those are the same kind of link work, and the window is where
   * their progress and log are visible.
   */
  const [connectHostId, setConnectHostId] = useState(null)
  // The loopback URL the guest loads (GET /hosts/:id/open); it carries the
  // one-shot launch token, so it is fetched on demand and never persisted.
  const [remoteUrl, setRemoteUrl] = useState(null)
  const [busyHostId, setBusyHostId] = useState(null)
  const [diagnose, setDiagnose] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  // Deleting a host whose link is being built needs a second, explicit confirmation.
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [passwordPrompt, setPasswordPrompt] = useState(null)
  // Synchronous guard: two Enter events in the same tick both see `pending.busy === false`
  // because React has not re-rendered yet, so the ref is what makes the submit idempotent.
  const passwordBusy = useRef(false)
  const [conflictBusy, setConflictBusy] = useState(false)
  const [fingerprintBusy, setFingerprintBusy] = useState(false)
  // A queue, not one slot: a second message used to replace the first before it could be
  // read (audit S3). Newest last, at most three, each with its own dismissal timer.
  const [toasts, setToasts] = useState([])
  const toastSeq = useRef(0)
  const toastTimers = useRef(new Map())
  const [wizard, setWizard] = useState(() => {
    const store = props.wizardStore
    return store && typeof store.current === 'function' ? store.current() : null
  })

  const dismissToast = (id) => {
    const timer = toastTimers.current.get(id)
    if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer)
    toastTimers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }
  const notify = (text, tone) => {
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
  const errorMessage = (error) => {
    const viewOfError = toErrorView(error)
    const title = resolveText(viewOfError.title, locale)
    const detail = resolveText(viewOfError.detail, locale)
    return detail ? title + ' ' + detail : title
  }

  /** Merge one Host job frame into the local card map, never letting a slow frame regress it. */
  const updateDownloadView = (job) => {
    if (!job || typeof job.id !== 'string') return null
    const current = downloadJobsRef.current[job.id] || null
    const merged = { ...(current || {}), ...job }
    const rank = { preparing: 0, ready: 1, saving: 2, done: 3, error: 3 }
    if (current && (rank[job.phase] ?? 0) < (rank[current.phase] ?? 0)) {
      merged.phase = current.phase
    }
    merged.doneBytes = Math.max(Number(current?.doneBytes) || 0, Number(job.doneBytes) || 0)
    merged.totalBytes = Math.max(Number(current?.totalBytes) || 0, Number(job.totalBytes) || 0)
    const next = { ...downloadJobsRef.current, [job.id]: merged }
    downloadJobsRef.current = next
    setDownloadJobs(next)
    return merged
  }

  const clearDownloadPoll = (id) => {
    const timer = downloadPolls.current.get(id)
    if (timer !== undefined && typeof clearInterval === 'function') clearInterval(timer)
    downloadPolls.current.delete(id)
  }

  const removeDownloadView = (id, delay) => {
    clearDownloadPoll(id)
    const previous = downloadRemoval.current.get(id)
    if (previous !== undefined && typeof clearTimeout === 'function') clearTimeout(previous)
    downloadRemoval.current.delete(id)
    const drop = () => {
      if (!downloadJobsRef.current[id]) return
      const next = { ...downloadJobsRef.current }
      delete next[id]
      downloadJobsRef.current = next
      setDownloadJobs(next)
    }
    if (delay && typeof setTimeout === 'function') {
      const timer = setTimeout(drop, delay)
      timer.unref?.()
      downloadRemoval.current.set(id, timer)
    } else {
      drop()
    }
  }

  /** Poll as a fallback for EventSource gaps; SSE normally stops this before it runs. */
  const startDownloadPoll = (id) => {
    if (downloadPolls.current.has(id) || typeof setInterval !== 'function') return
    const timer = setInterval(() => {
      const current = downloadJobsRef.current[id]
      if (!current || current.phase === 'saving' || current.phase === 'done') {
        clearDownloadPoll(id)
        return
      }
      api.downloadStatus(id).then(
        (job) => {
          handleDownloadJob(job)
          if (job.phase === 'ready' || job.phase === 'error') clearDownloadPoll(id)
        },
        (error) => {
          clearDownloadPoll(id)
          const current = downloadJobsRef.current[id]
          if (current && (current.phase === 'preparing' || current.phase === 'ready')) {
            updateDownloadView({ id, phase: 'error', error: toErrorView(error) })
            notify(errorMessage(error), 'error')
            removeDownloadView(id, 5000)
          }
        },
      )
    }, 700)
    timer.unref?.()
    downloadPolls.current.set(id, timer)
  }

  /** A completed job is already written to the chosen local path by the Host. */
  const finishSavedDownload = (job) => {
    if (!job || typeof job.id !== 'string') return
    const destination = job.destination || job.path || ''
    notify(t('downloadSavedTo', { path: destination }), 'success')
    updateDownloadView({ id: job.id, phase: 'done' })
    removeDownloadView(job.id, 1400)
    // The bytes never leave the Host, so release the job slot immediately.
    void api.cancelDownload(job.id).catch(() => {})
  }

  /** Route one job frame: show progress, then report the local path on ready. */
  const handleDownloadJob = (job) => {
    if (!job || typeof job.id !== 'string') return
    const previous = downloadJobsRef.current[job.id]
    const merged = updateDownloadView(job)
    if (!merged) return
    if (merged.phase === 'ready') {
      finishSavedDownload(merged)
      return
    }
    if (merged.phase === 'error') {
      clearDownloadPoll(job.id)
      if (!previous || previous.phase !== 'error') {
        const view = merged.error && typeof merged.error === 'object' ? merged.error : null
        const detail = view ? resolveText(view.detail, locale) : ''
        const title = view ? resolveText(view.title, locale) : ''
        notify(detail ? (title ? title + ' ' : '') + detail : title || t('downloadFailed'), 'error')
      }
      removeDownloadView(job.id, 5000)
    }
  }
  downloadHandlerRef.current = handleDownloadJob

  /** Start one Host job; every job streams into the directory picked by the user. */
  const startHostDownload = (request, destination) => {
    const fallbackName = request.name || request.path.split('/').pop() || 'download'
    notify(t('downloadStarted', { name: fallbackName }), 'info')
    api.startDownload(request.hostId, request.path, destination).then(
      (job) => {
        const merged = updateDownloadView(job)
        if (!merged) return
        if (merged.phase === 'ready') {
          finishSavedDownload(merged)
        } else if (merged.phase === 'preparing') {
          startDownloadPoll(job.id)
        }
      },
      (error) => notify(errorMessage(error), 'error'),
    )
  }

  /** Ask DSH's own directory picker for the local destination folder. */
  const pickFolderDestination = async () => {
    const workspacePick = typeof props.pickDirectory === 'function' ? props.pickDirectory : null
    if (workspacePick) {
      try {
        const picked = await workspacePick()
        if (picked === null) return null
        if (typeof picked === 'string' && picked !== '') return picked
      } catch (error) {
        notify(errorMessage(error), 'error')
        return null
      }
    }
    const picker = typeof window === 'undefined' ? null : window.__DSH_DIRECTORY_PICKER__
    if (!picker || typeof picker.pick !== 'function') {
      notify(t('downloadFolderDesktopOnly'), 'warn')
      return null
    }
    try {
      const picked = await picker.pick()
      return typeof picked === 'string' && picked !== '' ? picked : null
    } catch (error) {
      notify(errorMessage(error), 'error')
      return null
    }
  }

  /** A remote file/folder intent from the guest bridge becomes a Host job. */
  const downloadFromHost = (request) => {
    if (!request || typeof request.hostId !== 'string' || typeof request.path !== 'string') return
    notify(t('downloadFolderChoose'), 'info')
    pickFolderDestination().then((destination) => {
      if (destination) startHostDownload(request, destination)
    })
  }

  const cancelDownloadJob = (job) => {
    if (!job || typeof job.id !== 'string') return
    api.cancelDownload(job.id).then((cancelled) => {
      if (!cancelled) return
      notify(t('downloadCancelled'), 'info')
      removeDownloadView(job.id)
    })
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

  /**
   * One Host-API call with the window's choreography: the host goes busy, success refreshes
   * the state, a failure reaches the toast, and the flag clears either way.
   */
  const runAction = (host, work, done) => {
    if (!host || !host.id) return undefined
    setBusyHostId(host.id)
    return work()
      .then(
        (result) => {
          if (done) done(result)
          remote.refresh()
        },
        (error) => notify(errorMessage(error), 'error'),
      )
      .finally(() => setBusyHostId(null))
  }

  const hosts = state && Array.isArray(state.hosts) ? state.hosts : []
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
  const carrierHoldsView = (hostId, viewRev) => {
    const entry = carrierOf(hostId)
    if (entry === null) return false
    const entryRev = Number.isInteger(entry.viewRev) ? entry.viewRev : null
    return entryRev === viewRev
  }
  const hostsRef = useRef(hosts)
  hostsRef.current = hosts
  // A host we asked for that still has to connect: the list stays up until it is ready.
  const pendingSwitch = useRef(null)
  const pendingIntent = useRef(null)
  // Host we already told the user cannot be shown here (no desktop window seat).
  const noWindowNotified = useRef(null)

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
  const lastStreamMode = useRef('idle')
  useEffect(() => {
    const degraded = remote.mode === 'polling' || remote.mode === 'reconnecting'
    const wasDegraded = lastStreamMode.current === 'polling' || lastStreamMode.current === 'reconnecting'
    if (degraded && !wasDegraded) notify(t('liveStreamLostTitle'), 'warn')
    else if (remote.mode === 'live' && wasDegraded) notify(t('liveStreamRestored'), 'success')
    lastStreamMode.current = remote.mode
  }, [remote.mode])

  // A failed connect drops the prompt too; the toast carries the reason.
  const performConnect = (host, password, rememberPassword) =>
    runAction(
      host,
      () =>
        api.connect(
          host.id,
          typeof password === 'string' ? { password, rememberPassword: rememberPassword !== false } : {},
        ),
      () => setPasswordPrompt(null),
    )

  /**
   * Show this host's connect body (progress + log) in the management window. Used by every
   * action that rebuilds a link in place: opening a host, reconnecting, restarting.
   */
  const showConnectWindow = (host) => {
    if (!host || typeof host.id !== 'string') return
    setConnectHostId(host.id)
    setManageView('connect')
    setManageOpen(true)
  }

  /**
   * Start a connection, asking for the password first when the host uses password auth
   * and none is remembered. A saved password is never read by the Client: the Host tries
   * it, and the prompt only appears when the Host reports an auth failure.
   */
  const openHost = (host, options) => {
    if (!host) return
    const opts = options || {}
    const password = typeof opts.password === 'string' && opts.password !== '' ? opts.password : null
    const rememberPassword = opts.rememberPassword !== false
    const needsConnect = statusOf(host.status).connect === true
    const ready = host.status === 'connected'
    if (needsConnect && host.authType === 'password' && password === null) {
      if (host.passwordSaved === true) {
        // A remembered password is never read by the Client: try the connect without one,
        // and only ask when the Host says that password no longer works (audit S2-2).
        pendingSwitch.current = host.id
        showConnectWindow(host)
        setTarget(host.id)
        api.activate(host.id).catch(() => {})
        setBusyHostId(host.id)
        api.connect(host.id, {}).then(
          () => {
            setBusyHostId(null)
            remote.refresh()
          },
          (error) => {
            setBusyHostId(null)
            const view = toErrorView(error)
            if (view && view.code === 'auth') {
              setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
              return
            }
            notify(errorMessage(error), 'error')
          },
        )
        return
      }
      pendingSwitch.current = host.id
      showConnectWindow(host)
      setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
      return
    }
    pendingSwitch.current = ready ? null : host.id
    setConnectHostId(host.id)
    setManageView('connect')
    setManageOpen(!ready)
    setTarget(host.id)
    api.activate(host.id).catch(() => {})
    if (needsConnect) performConnect(host, password, rememberPassword)
  }

  // The switcher and the Settings page name one target: open a host, leave one, show
  // host management, or hand the window back to the local page.
  const applyIntent = (intent) => {
    if (!intent || typeof intent !== 'object') return
    if (intent.kind === 'manage') {
      pendingIntent.current = null
      // The explicit entry always shows the list, even while a connection is running: the
      // connect window is what a host pick opens, not what 管理界面 means.
      setManageView('list')
      setManageOpen(true)
      remote.refresh()
      return
    }
    if (intent.kind === 'local') {
      pendingIntent.current = null
      setManageOpen(false)
      setTarget(null)
      // The Host side remembers which host fills the window; nothing does while local
      // content is up, so clear it instead of leaving a stale "current".
      api.clearActive().catch(() => {})
      return
    }
    const host = hostsRef.current.find((item) => item && item.id === intent.hostId) || null
    if (intent.kind === 'disconnect') {
      pendingIntent.current = null
      // Disconnecting hands the window back once the Host confirms (see `disconnectHost`): doing it here would show
      // the local page even if the disconnect then failed.
      if (host !== null) disconnectHost(host)
      return
    }
    if (host === null) {
      pendingIntent.current = intent
      return
    }
    pendingIntent.current = null
    openHost(host)
  }
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

  const submitPassword = (submitted) => {
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

  // The remote UI goes away with the connection: give its renderer back now, and hand the
  // window back if that is where it is pointing. The update is functional on purpose: this
  // callback runs from the long-lived intent subscription, whose closure still holds the
  // target it was created with, so a captured value would miss the host the window is on.
  const disconnectHost = (host) =>
    runAction(
      host,
      () => api.disconnect(host.id, false),
      () => {
        setTarget((current) => (current === host.id ? null : current))
        closeCarrier(host.id).catch(() => {})
      },
    )

  const reconnectHost = (host) => {
    if (!host) return
    if (host.authType === 'password') {
      setPasswordPrompt({ host, intent: 'reconnect', error: null, busy: false })
      return
    }
    setRemoteUrl(null)
    closeCarrier(host.id).catch(() => {})
    // Reconnect rebuilds the link: show its progress and log like a first connection.
    showConnectWindow(host)
    runAction(host, () => api.reconnect(host.id))
  }

  /**
   * Restart the managed remote web. The Host stops the pid it launched on the same SSH
   * session and re-runs `[start]`; the state stream shows `restarting-remote` and the
   * carrier navigates to the new launch URL once the host is connected again. The connect
   * window is what shows the restart's progress and the log it writes.
   */
  const restartHost = (host) => {
    if (!host) return undefined
    showConnectWindow(host)
    return runAction(
      host,
      () => api.restart(host.id),
      (result) => {
        // A repair or another one-shot action owns the link: say so instead of doing nothing.
        if (result && result.accepted === false && result.reason === 'busy') {
          notify(t('remoteRestartBusy'), 'info')
        }
      },
    )
  }

  /**
   * Stop the remote DSH this connection manages (the "Stop remote DSH" card action). The
   * Host stops only the process it launched or took over, then releases the tunnel and the
   * SSH session; the host lands on `disconnected` with its settings kept. The remote UI
   * goes away with the link, so its carrier is released here as well.
   */
  const stopRemoteHost = (host) => {
    if (!host) return undefined
    return runAction(
      host,
      () => api.stopRemote(host.id),
      () => {
        setTarget((current) => (current === host.id ? null : current))
        closeCarrier(host.id).catch(() => {})
      },
    )
  }

  const resolveConflict = (host, action) => {
    if (!host || !host.id) return
    setConflictBusy(true)
    api
      .confirmConflict(host.id, action)
      .then(
        () => remote.refresh(),
        (error) => notify(errorMessage(error), 'error'),
      )
      .finally(() => setConflictBusy(false))
  }

  const runDiagnose = (host) => {
    if (!host || !host.id) return
    setDiagnose({ host, status: 'loading', report: null, error: null })
    api.diagnose(host.id).then(
      (report) =>
        setDiagnose((current) =>
          current && current.host && current.host.id === host.id ? { ...current, status: 'done', report } : current,
        ),
      (error) =>
        setDiagnose((current) =>
          current && current.host && current.host.id === host.id
            ? { ...current, status: 'error', error: toErrorView(error) }
            : current,
        ),
    )
  }
  const rerunDiagnose = () => {
    if (diagnose && diagnose.host) runDiagnose(diagnose.host)
  }

  const confirmDeleteHost = () => {
    if (!pendingDelete || deleting) return
    // A connecting host has a live link-work action behind it: one more click is what makes
    // the user read the warning instead of losing that connection to a single Enter (S3).
    if (pendingDelete.status === 'connecting' && deleteArmed !== true) {
      setDeleteArmed(true)
      return
    }
    setDeleting(true)
    const deletedId = pendingDelete.id
    api
      .deleteHost(deletedId)
      .then(
        () => {
          setPendingDelete(null)
          closeCarrier(deletedId).catch(() => {})
          if (target === deletedId) setTarget(null)
          remote.refresh()
        },
        (error) => notify(errorMessage(error), 'error'),
      )
      .finally(() => setDeleting(false))
  }

  const saveSettings = async (patch) => {
    const saved = await api.saveSettings(patch)
    remote.patch((current) => ({ ...current, settings: saved }))
    notify(t('settings.saved'), 'success')
  }

  const answerFingerprint = (host, accept, remember) => {
    if (!host || !host.id) return
    const sha256 = host.fingerprint && typeof host.fingerprint.sha256 === 'string' ? host.fingerprint.sha256 : ''
    setFingerprintBusy(true)
    api.acceptFingerprint(host.id, accept === true, remember === true, sha256).then(
      () => {
        setFingerprintBusy(false)
        remote.refresh()
      },
      (error) => {
        setFingerprintBusy(false)
        notify(errorMessage(error), 'error')
      },
    )
  }

  const openWizard = (draft) => {
    if (props.wizardStore) props.wizardStore.open(draft)
  }

  return h(
    'div',
    { className: 'drg-root drg-overlay', 'data-testid': 'dsh-remote-go-overlay-host' },
    h(StyleSheet),
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
      onRetryLive: remote.reconnectStream,
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
