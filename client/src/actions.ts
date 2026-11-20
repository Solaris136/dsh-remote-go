// client/src/actions.ts - the overlay host's commands (downloads, host actions, dialog plumbing) as one factory; after manage-window.ts, before plugin-overlay.ts.
/** The overlay host's commands, built from `deps`: the per-render state, rebuilt every render. */
// Destructured under the same names, so a command reads its own render's `target` / `pendingDelete` / `diagnose`.
function createOverlayActions(deps: OverlayActionDeps) {
  const { props, t, locale, notify, errorMessage, remote, downloadJobsRef, setDownloadJobs, downloadPolls } = deps
  const { downloadRemoval, downloadHandlerRef, target, setTarget, setManageOpen, setManageView } = deps
  const { setConnectHostId, setRemoteUrl, setBusyHostId, diagnose, setDiagnose, pendingDelete, setPendingDelete } = deps
  const { deleting, setDeleting, deleteArmed, setDeleteArmed, setPasswordPrompt, setConflictBusy, setFingerprintBusy } =
    deps
  const { hostsRef, pendingSwitch, pendingIntent } = deps
  /** Merge one Host job frame into the local card map, never letting a slow frame regress it. */
  const updateDownloadView = (job: DownloadCardView) => {
    if (!job || typeof job.id !== 'string') return null
    const current = downloadJobsRef.current[job.id] || null
    const merged = { ...(current || {}), ...job }
    const rank: Record<DownloadPhase, number> = { preparing: 0, ready: 1, saving: 2, done: 3, error: 3 }
    if (current && (rank[job.phase] ?? 0) < (rank[current.phase] ?? 0)) merged.phase = current.phase
    merged.doneBytes = Math.max(Number(current?.doneBytes) || 0, Number(job.doneBytes) || 0)
    merged.totalBytes = Math.max(Number(current?.totalBytes) || 0, Number(job.totalBytes) || 0)
    const next = { ...downloadJobsRef.current, [job.id]: merged }
    downloadJobsRef.current = next
    setDownloadJobs(next)
    return merged
  }

  const clearDownloadPoll = (id: string) => {
    const timer = downloadPolls.current.get(id)
    if (timer !== undefined && typeof clearInterval === 'function') clearInterval(timer)
    downloadPolls.current.delete(id)
  }

  const removeDownloadView = (id: string, delay?: number) => {
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
    if (!delay || typeof setTimeout !== 'function') {
      drop()
      return
    }
    const timer = setTimeout(drop, delay)
    unrefTimer(timer)
    downloadRemoval.current.set(id, timer)
  }

  /** Poll as a fallback for EventSource gaps; SSE normally stops this before it runs. */
  const startDownloadPoll = (id: string) => {
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
          const latest = downloadJobsRef.current[id]
          if (!latest || (latest.phase !== 'preparing' && latest.phase !== 'ready')) return
          updateDownloadView({ id, phase: 'error', error: toErrorView(error) })
          notify(errorMessage(error), 'error')
          removeDownloadView(id, 5000)
        },
      )
    }, 700)
    unrefTimer(timer)
    downloadPolls.current.set(id, timer)
  }

  /** A completed job is already written to the chosen local path by the Host. */
  const finishSavedDownload = (job: DownloadCardView) => {
    if (!job || typeof job.id !== 'string') return
    notify(t('downloadSavedTo', { path: job.destination || job.path || '' }), 'success')
    updateDownloadView({ id: job.id, phase: 'done' })
    removeDownloadView(job.id, 1400)
    // The bytes never leave the Host, so release the job slot immediately.
    void api.cancelDownload(job.id).catch(() => {})
  }

  /** Route one job frame: show progress, then report the local path on ready. */
  const handleDownloadJob = (job: DownloadJobView) => {
    if (!job || typeof job.id !== 'string') return
    const previous = downloadJobsRef.current[job.id]
    const merged = updateDownloadView(job)
    if (!merged) return
    if (merged.phase === 'ready') return finishSavedDownload(merged)
    if (merged.phase !== 'error') return
    clearDownloadPoll(job.id)
    if (!previous || previous.phase !== 'error') {
      const view = merged.error && typeof merged.error === 'object' ? merged.error : null
      const detail = view ? resolveText(view.detail, locale) : ''
      const title = view ? resolveText(view.title, locale) : ''
      notify(detail ? (title ? title + ' ' : '') + detail : title || t('downloadFailed'), 'error')
    }
    removeDownloadView(job.id, 5000)
  }
  downloadHandlerRef.current = handleDownloadJob
  /** Start one Host job; every job streams into the directory picked by the user. */
  const startHostDownload = (request: { hostId: string; path: string; name: string }, destination: string) => {
    const fallbackName = request.name || request.path.split('/').pop() || 'download'
    notify(t('downloadStarted', { name: fallbackName }), 'info')
    api.startDownload(request.hostId, request.path, destination).then(
      (job) => {
        const merged = updateDownloadView(job)
        if (!merged) return
        if (merged.phase === 'ready') finishSavedDownload(merged)
        else if (merged.phase === 'preparing') startDownloadPoll(job.id)
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
  const downloadFromHost = (request: { hostId: string; path: string; name: string }) => {
    if (!request || typeof request.hostId !== 'string' || typeof request.path !== 'string') return
    notify(t('downloadFolderChoose'), 'info')
    pickFolderDestination().then((destination) => {
      if (destination) startHostDownload(request, destination)
    })
  }

  const cancelDownloadJob = (job: DownloadCardView) => {
    if (!job || typeof job.id !== 'string') return
    api.cancelDownload(job.id).then((cancelled) => {
      if (!cancelled) return
      notify(t('downloadCancelled'), 'info')
      removeDownloadView(job.id)
    })
  }

  /** One Host-API call: busy on, success refreshes, a failure reaches the toast, and the flag clears either way. */
  const runAction = <T>(host: HostLike, work: () => Promise<T>, done?: (result: T) => void) => {
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

  // A failed connect drops the prompt too; the toast carries the reason.
  const performConnect = (host: HostLike, password: string | null, rememberPassword: boolean) =>
    runAction(
      host,
      () =>
        api.connect(
          host.id,
          typeof password === 'string' ? { password, rememberPassword: rememberPassword !== false } : {},
        ),
      () => setPasswordPrompt(null),
    )

  /** Show this host's connect body (progress + log) in the management window. */
  const showConnectWindow = (host: HostLike) => {
    if (!host || typeof host.id !== 'string') return
    setConnectHostId(host.id)
    setManageView('connect')
    setManageOpen(true)
  }

  /** Start a connection, asking for the password first when the host uses password auth and none is remembered. */
  // A saved password is never read by the Client: the Host tries it, and the prompt appears only on its auth failure.
  const openHost = (host: HostLike, options?: ConnectRequest) => {
    if (!host) return
    const opts = options || {}
    const password = typeof opts.password === 'string' && opts.password !== '' ? opts.password : null
    const rememberPassword = opts.rememberPassword !== false
    const needsConnect = statusOf(host.status).connect === true
    const ready = host.status === 'connected'
    if (needsConnect && host.authType === 'password' && password === null) {
      pendingSwitch.current = host.id
      showConnectWindow(host)
      if (host.passwordSaved !== true) {
        setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
        return
      }
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
          if (toErrorView(error).code === 'auth') setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
          else notify(errorMessage(error), 'error')
        },
      )
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

  // Switcher and Settings name one target: open a host, leave one, manage hosts, or hand the window back to local.
  const applyIntent = (intent: PanelRequest | null | undefined) => {
    if (!intent || typeof intent !== 'object') return
    if (intent.kind === 'manage') {
      pendingIntent.current = null
      // The explicit entry always shows the list, even while a connection is running.
      setManageView('list')
      setManageOpen(true)
      remote.refresh()
      return
    }
    if (intent.kind === 'local') {
      pendingIntent.current = null
      setManageOpen(false)
      setTarget(null)
      // Nothing fills the window while local content is up, so clear the Host's "current" instead.
      api.clearActive().catch(() => {})
      return
    }
    const host = hostsRef.current.find((item) => item && item.id === intent.hostId) || null
    if (intent.kind === 'disconnect') {
      pendingIntent.current = null
      // Disconnecting hands the window back once the Host confirms (see `disconnectHost`).
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

  // The remote UI goes with the connection: release its renderer, and hand the window back if it points there.
  // The update is functional on purpose: the long-lived intent subscription's closure still holds the old target.
  const disconnectHost = (host: HostLike) =>
    runAction(
      host,
      () => api.disconnect(host.id, false),
      () => {
        setTarget((current) => (current === host.id ? null : current))
        closeCarrier(host.id).catch(() => {})
      },
    )

  const reconnectHost = (host: HostLike) => {
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

  /** Restart the remote web: the Host stops the pid it launched on that SSH session and re-runs `[start]`. */
  // `/state` then shows `restarting-remote`, and the connect window carries the log.
  const restartHost = (host: HostLike) => {
    if (!host) return undefined
    showConnectWindow(host)
    return runAction(
      host,
      () => api.restart(host.id),
      (result) => {
        // A repair or another one-shot action owns the link: say so instead of doing nothing.
        if (result && result.accepted === false && result.reason === 'busy') notify(t('remoteRestartBusy'), 'info')
      },
    )
  }

  /** Stop the remote DSH this connection manages: the Host stops only the process it launched or took over. */
  // That releases the tunnel and the SSH session; the host lands on `disconnected` with its settings kept.
  // The remote UI goes with the link, so its carrier is released here as well.
  const stopRemoteHost = (host: HostLike) => {
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

  const resolveConflict = (host: Partial<HostView>, action: string) => {
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

  const runDiagnose = (host: HostLike) => {
    if (!host || !host.id) return
    const mine = (current: DiagnoseState | null) => current && current.host && current.host.id === host.id
    setDiagnose({ host, status: 'loading', report: null, error: null })
    api.diagnose(host.id).then(
      (report) => setDiagnose((current) => (mine(current) ? { ...current, status: 'done', report } : current)),
      (error) =>
        setDiagnose((current) =>
          mine(current) ? { ...current, status: 'error', error: toErrorView(error) } : current,
        ),
    )
  }
  const rerunDiagnose = () => {
    if (diagnose && diagnose.host) runDiagnose(diagnose.host)
  }

  const confirmDeleteHost = () => {
    if (!pendingDelete || deleting) return
    // A connecting host has live link work: a second click makes the user read the warning instead of losing the link.
    if (pendingDelete.status === 'connecting' && deleteArmed !== true) return setDeleteArmed(true)
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

  const saveSettings = async (patch: SettingsPatch) => {
    const saved = await api.saveSettings(patch)
    remote.patch((current) => ({ ...current, settings: saved }))
    notify(t('settings.saved'), 'success')
  }

  const answerFingerprint = (host: HostLike, accept: boolean, remember: boolean) => {
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

  const openWizard = (draft: WizardOpenInput) => {
    if (props.wizardStore) props.wizardStore.open(draft)
  }

  return {
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
  }
}
