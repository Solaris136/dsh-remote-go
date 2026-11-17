// client/src/actions.ts - the overlay host's commands (downloads, host actions, dialog plumbing) as one factory; after manage-window.ts, before plugin-overlay.ts.
/**
 * Every promise-chained command the overlay host offers: the download jobs, the host actions, the
 * prompts and the wizard. They were the body of `PluginOverlay` (P3c, design-client.md §4.3) and are
 * moved here verbatim: a command only needs the Host API - which is script scope - plus the
 * overlay's own setters and refs.
 *
 * `deps` is that per-render state. It is rebuilt on every render and the component destructures the
 * result under the same names, so every call site and every closure the command used to capture is
 * unchanged: a command still reads the `target` / `pendingDelete` / `diagnose` of the render it
 * belongs to, exactly as the inline declarations did.
 */
function createOverlayActions(deps) {
  const {
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
  } = deps

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

  const removeDownloadView = (id, delay?) => {
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
      const timer: TimerHandle = setTimeout(drop, delay)
      timer.unref?.()
      downloadRemoval.current.set(id, timer)
    } else {
      drop()
    }
  }

  /** Poll as a fallback for EventSource gaps; SSE normally stops this before it runs. */
  const startDownloadPoll = (id) => {
    if (downloadPolls.current.has(id) || typeof setInterval !== 'function') return
    const timer: TimerHandle = setInterval(() => {
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

  /**
   * One Host-API call with the window's choreography: the host goes busy, success refreshes
   * the state, a failure reaches the toast, and the flag clears either way.
   */
  const runAction = (host, work, done?) => {
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
  const openHost = (host, options?) => {
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
