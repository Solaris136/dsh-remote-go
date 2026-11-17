// client/src/manage-window.ts - ManageWindow, the remote host manager dialog; after overlay-state.ts, before plugin-overlay.ts.
function ManageWindow(props) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  if (props.open !== true) return null
  const host = props.host || null
  const connecting = props.view === 'connect' && host !== null && statusOf(host.status).window === true
  return h(
    'div',
    { className: 'drg-manage-window', 'data-testid': 'manage-window' },
    h(
      Modal,
      { wide: true, onClose: props.onClose, closeLabel: t('cancel'), ariaLabel: t('hostsTitle') },
      connecting
        ? h(ConnectWindow, {
            t,
            locale,
            host,
            fingerprintBusy: props.fingerprintBusy === true,
            onAcceptFingerprint: (remember) => props.onAcceptFingerprint(host, remember),
            onRejectFingerprint: () => props.onRejectFingerprint(host),
            onRetry: () => props.onRetry(host),
            onDiagnose: () => props.onDiagnose(host),
            // Leaving a failure means going back to the list, inside the same window.
            onBack: typeof props.onShowList === 'function' ? props.onShowList : props.onClose,
          })
        : h(HostListView, {
            t,
            locale,
            state: props.state,
            loading: props.loading,
            error: props.error,
            busyHostId: props.busyHostId,
            mode: props.mode,
            onRetryLive: props.onRetryLive,
            onAdd: props.onAdd,
            onRefresh: props.onRefresh,
            onOpenSettings: props.onOpenSettings,
            onOpenHost: props.onOpenHost,
            onDisconnectHost: props.onDisconnectHost,
            onReconnectHost: props.onReconnectHost,
            onRestartHost: props.onRestartHost,
            onStopRemote: props.onStopRemoteHost,
            onEditHost: props.onEditHost,
            onDeleteHost: props.onDeleteHost,
            onDiagnoseHost: props.onDiagnoseHost,
          }),
    ),
  )
}
